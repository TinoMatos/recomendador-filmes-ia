import * as tf from 'https://esm.sh/@tensorflow/tfjs@4.22.0';

const workerEvents = {
    trainingComplete: 'training:complete',
    trainModel: 'train:model',
    recommend: 'recommend',
};

let _globalCtx = {};
let _model = null;

// Fallback de dataset, usado caso o frontend não envie filmes no treino.
const DATASET_URL = new URL('/data/movies_tmdb.json', self.location.origin).href;

// Normaliza valores numéricos para escala [0, 1].
// Ex.: ano, idade, rating.
// Isso ajuda o modelo a aprender melhor, pois as variáveis ficam comparáveis.
const normalize = (value, min, max) => (value - min) / ((max - min) || 1);

// Cria um contexto com estatísticas e índices necessários para feature engineering.
// Entrada: lista de filmes e usuários.
// Saída: objeto com ranges, mapeamentos e médias por filme.
function makeContext(movies, users) {
    const ages = users.map(u => u.age);
    const years = movies.map(m => m.year);
    const ratings = movies.map(m => m.rating);

    const minAge = Math.min(...ages);
    const maxAge = Math.max(...ages);
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);
    const minRating = Math.min(...ratings);
    const maxRating = Math.max(...ratings);

    // Vocabulário de gêneros e índice numérico de cada gênero.
    const genres = [...new Set(movies.flatMap(m => m.genres || []))];
    const genreIndex = Object.fromEntries(genres.map((genre, index) => [genre, index]));

    // Lookup rápido de filme por ID.
    const movieById = Object.fromEntries(movies.map(m => [m.id, m]));

    // Calcula idade média dos usuários que assistiram cada filme.
    // Isso vira uma feature útil para afinidade por faixa etária.
    const ageSums = {};
    const ageCounts = {};
    users.forEach(u => {
        u.watched.forEach(movie => {
            ageSums[movie.id] = (ageSums[movie.id] || 0) + u.age;
            ageCounts[movie.id] = (ageCounts[movie.id] || 0) + 1;
        });
    });

    // Se um filme não tiver histórico de idade, usa o ponto médio global.
    const midAge = (minAge + maxAge) / 2;
    const movieAvgAgeNorm = Object.fromEntries(
        movies.map(m => {
            const avg = ageCounts[m.id]
                ? ageSums[m.id] / ageCounts[m.id]
                : midAge;
            return [m.id, normalize(avg, minAge, maxAge)];
        })
    );

    return {
        movies,
        users,
        movieById,
        movieAvgAgeNorm,
        minAge,
        maxAge,
        minYear,
        maxYear,
        minRating,
        maxRating,
        genres,
        genreIndex,
    };
}


function getWatchedMovies(user, ctx) {
    return (user.watched || [])
        .map(w => ctx.movieById[w.id])
        .filter(Boolean);
}

// Monta perfil de gêneros do usuário com pesos normalizados.
// Ex.: { drama: 0.5, romance: 0.3, ... }
function buildGenreProfile(watchedMovies) {
    const profile = {};
    let totalGenres = 0;

    watchedMovies.forEach(movie => {
        movie.genres.forEach(genre => {
            profile[genre] = (profile[genre] || 0) + 1;
            totalGenres += 1;
        });
    });

    if (!totalGenres) {
        return profile;
    }

    Object.keys(profile).forEach(genre => {
        profile[genre] = profile[genre] / totalGenres;
    });

    return profile;
}

// Similaridade de gênero entre um filme candidato e o perfil de gêneros do usuário.
// Retorna valor entre 0 e 1.
function scoreGenre(movie, genreProfile) {
    if (!movie.genres?.length) return 0.5;
    const values = movie.genres.map(genre => genreProfile[genre] || 0);
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.min(1, avg * 4);
}

// Similaridade de ano do filme candidato com o histórico do usuário.
// Se usuário não tem histórico, retorna neutro (0.5).
function scoreYear(movie, watchedMovies, ctx) {
    if (!watchedMovies.length) return 0.5;
    const avgYear = watchedMovies.reduce((sum, current) => sum + current.year, 0) / watchedMovies.length;
    const movieNorm = normalize(movie.year, ctx.minYear, ctx.maxYear);
    const avgNorm = normalize(avgYear, ctx.minYear, ctx.maxYear);
    return 1 - Math.abs(movieNorm - avgNorm);
}


function scoreRating(movie, ctx) {
    return normalize(movie.rating, ctx.minRating, ctx.maxRating);
}

// Score de proximidade entre idade do usuário e idade média do público do filme.
// Mantido para referência; atualmente a feature equivalente é calculada em buildFeatureVector.
function scoreAge(movie, user, ctx) {
    const userAgeNorm = normalize(user.age, ctx.minAge, ctx.maxAge);
    const movieAgeNorm = ctx.movieAvgAgeNorm[movie.id] ?? 0.5;
    return 1 - Math.abs(userAgeNorm - movieAgeNorm);
}

function buildUserProfile(user, ctx) {
    const watchedMovies = getWatchedMovies(user, ctx);
    const genreProfile = buildGenreProfile(watchedMovies);

    // Ano médio do histórico do usuário (fallback: meio do range global).
    const avgYear = watchedMovies.length
        ? watchedMovies.reduce((sum, current) => sum + current.year, 0) / watchedMovies.length
        : (ctx.minYear + ctx.maxYear) / 2;

    return {
        watchedMovies,
        watchedIds: new Set((user.watched || []).map(item => item.id)),
        genreProfile,
        avgYearNorm: normalize(avgYear, ctx.minYear, ctx.maxYear),
        userAgeNorm: normalize(user.age, ctx.minAge, ctx.maxAge),
    };
}

// Constrói o vetor numérico de features para um par (usuário, filme).
// Esse vetor é usado no treino e também na inferência.
function buildFeatureVector(movie, userProfile, ctx) {
    const genre = scoreGenre(movie, userProfile.genreProfile);
    const year = scoreYear(movie, userProfile.watchedMovies, ctx);
    const rating = scoreRating(movie, ctx);

    // Similaridade etária entre usuário e público médio do filme.
    const age = 1 - Math.abs(userProfile.userAgeNorm - (ctx.movieAvgAgeNorm[movie.id] ?? 0.5));

    // Distância entre ano do filme e ano médio do histórico do usuário.
    const movieYearNorm = normalize(movie.year, ctx.minYear, ctx.maxYear);
    const yearDistance = 1 - Math.abs(movieYearNorm - userProfile.avgYearNorm);

    // Features densas principais + combinações simples (interações).
    const vector = [
        genre,
        year,
        rating,
        age,
        yearDistance,
        genre * rating,
        age * rating,
        userProfile.watchedMovies.length ? 1 : 0,
    ];

    // Bag-of-genres binária do filme candidato.
    const genreBag = new Array(ctx.genres.length).fill(0);
    (movie.genres || []).forEach((genre) => {
        const index = ctx.genreIndex[genre];
        if (Number.isFinite(index)) {
            genreBag[index] = 1;
        }
    });

    return vector.concat(genreBag);
}

// Monta dataset supervisionado:
// - Positivos: filmes que o usuário assistiu (label 1)
// - Negativos: amostra de filmes não assistidos (label 0)
function buildTrainingDataset(ctx) {
    const features = [];
    const labels = [];

    ctx.users.forEach((user) => {
        const userProfile = buildUserProfile(user, ctx);
        const watchedSet = userProfile.watchedIds;
        if (!watchedSet.size) {
            return;
        }

        const positives = ctx.movies.filter(movie => watchedSet.has(movie.id));
        const negatives = ctx.movies.filter(movie => !watchedSet.has(movie.id));

        // Todos os positivos entram no treino.
        positives.forEach((movie) => {
            features.push(buildFeatureVector(movie, userProfile, ctx));
            labels.push([1]);
        });

        // Balanceia com quantidade semelhante de negativos.
        const negativeCount = Math.min(positives.length, negatives.length);
        for (let index = 0; index < negativeCount; index += 1) {
            const movie = negatives[index];
            features.push(buildFeatureVector(movie, userProfile, ctx));
            labels.push([0]);
        }
    });

    return { features, labels };
}

// Define arquitetura simples de rede neural para classificação binária.
// Saída sigmoid => probabilidade de o usuário gostar do filme.
function buildModel(inputSize) {
    const model = tf.sequential();
    model.add(tf.layers.dense({ inputShape: [inputSize], units: 128, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 64, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));

    model.compile({
        optimizer: tf.train.adam(0.01),
        loss: 'binaryCrossentropy',
        metrics: ['accuracy'],
    });

    return model;
}

// Handler da ação de treino:
// 1) carrega dados
// 2) monta contexto e dataset
// 3) treina modelo TFJS
// 4) devolve evento de conclusão
async function trainModel({ users, movies }) {
    try {
        postMessage({ type: 'training:start' });

        let trainingMovies = movies;
        if (!Array.isArray(trainingMovies) || trainingMovies.length === 0) {
            const response = await fetch(DATASET_URL);
            if (!response.ok) {
                throw new Error(`Não foi possível carregar dataset (${response.status})`);
            }
            trainingMovies = await response.json();
        }

        if (!Array.isArray(users) || users.length === 0) {
            throw new Error('Nenhum usuário disponível para treino.');
        }

        _globalCtx = makeContext(trainingMovies, users);
        const dataset = buildTrainingDataset(_globalCtx);
        if (!dataset.features.length) {
            throw new Error('Dados insuficientes para treinar o modelo.');
        }

        // Se já houver modelo anterior, libera memória antes de retreinar.
        if (_model) {
            _model.dispose();
            _model = null;
        }

        const inputSize = dataset.features[0].length;

        // Converte arrays JS para tensores TFJS.
        const xs = tf.tensor2d(dataset.features, [dataset.features.length, inputSize], 'float32');
        const ys = tf.tensor2d(dataset.labels, [dataset.labels.length, 1], 'float32');

        _model = buildModel(inputSize);
        await _model.fit(xs, ys, {
            epochs: 100,
            batchSize: 32,
            shuffle: true,
            verbose: 0,
        });

        xs.dispose();
        ys.dispose();

        postMessage({
            type: workerEvents.trainingComplete,
            stats: {
                movies: trainingMovies.length,
                users: users.length,
            },
        });
    } catch (error) {
        postMessage({
            type: 'error',
            message: `Falha no treino: ${error?.message || 'erro desconhecido'}`,
        });
    }
}

// Handler da ação de recomendação:
// 1) monta features dos candidatos não assistidos
// 2) roda inferência no modelo
// 3) ordena por score e retorna top 10
async function recommend({ user }) {
    if (!_globalCtx.movies?.length || !_model) {
        postMessage({ type: 'error', message: 'Modelo ainda não treinado. Clique em Treinar modelo primeiro.' });
        return;
    }

    const ctx = _globalCtx;
    const userProfile = buildUserProfile(user, ctx);

    // Remove filmes já assistidos dos candidatos.
    const watchedIds = new Set((user.watched || []).map(w => w.id));
    const candidates = ctx.movies.filter(m => !watchedIds.has(m.id));
    if (!candidates.length) {
        postMessage({ type: 'error', message: 'Nenhum filme disponível para recomendar. Desmarque alguns filmes assistidos.' });
        return;
    }

    const features = candidates.map(movie => buildFeatureVector(movie, userProfile, ctx));
    const input = tf.tensor2d(features, [features.length, features[0].length], 'float32');

  
    const output = _model.predict(input);
    const predictionTensor = Array.isArray(output) ? output[0] : output;
    const probabilities = await predictionTensor.data();


    input.dispose();
    predictionTensor.dispose();

    // Junta score com dados dos filmes.
    const recs = candidates.map((movie, index) => {
        const score = probabilities[index] ?? 0;
        const confidence = Math.max(0, Math.min(100, Math.round(score * 100)));
        return {
            ...movie,
            score,
            confidence,
        };
    });

    recs.sort((a, b) => b.score - a.score);

    postMessage({
        type: workerEvents.recommend,
        user,
        recommendations: recs.slice(0, 10),
    });
}


const handlers = {
    [workerEvents.trainModel]: trainModel,
    [workerEvents.recommend]: recommend,


    trainModel,
};

self.onmessage = async (e) => {
    const { action, ...data } = e.data;

    if (!handlers[action]) {
        postMessage({ type: 'error', message: `Ação desconhecida: ${action}` });
        return;
    }

    try {
        await handlers[action](data);
    } catch (error) {
        postMessage({
            type: 'error',
            message: `Falha ao processar ação: ${error?.message || 'erro desconhecido'}`,
        });
    }
};
