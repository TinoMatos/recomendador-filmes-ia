let allMovies = [];
let trainingUsers = [];
let isModelTrained = false;
let trainingTimeoutId = null;
let saveWatchedTimeoutId = null;

const selectedWatchedIds = new Set();
const worker = new Worker('/public/workers/movieRecommendationWorker.js', { type: 'module' });

const status = document.getElementById('status');
const results = document.getElementById('results');
const moviesGrid = document.getElementById('moviesGrid');
const watchedInput = document.getElementById('watched');
const userSelect = document.getElementById('userSelect');
const selectedUserSummary = document.getElementById('selectedUserSummary');
const selectedUserMovies = document.getElementById('selectedUserMovies');
const clearSelectionBtn = document.getElementById('clearSelectionBtn');
const trainBtn = document.getElementById('trainBtn');
const ageInput = document.getElementById('age');
const testForm = document.getElementById('testForm');

const GENRE_LABELS_PT = {
    action: 'Ação',
    drama: 'Drama',
    'sci-fi': 'Ficção Científica',
    crime: 'Crime',
    romance: 'Romance',
    thriller: 'Suspense',
    animation: 'Animação',
    family: 'Família',
    history: 'História',
    adventure: 'Aventura',
};

function formatGenresPt(genres = []) {
    return genres.map(genre => GENRE_LABELS_PT[genre] || genre).join(', ');
}

function buildFallbackPoster(title, width = 300, height = 450) {
    const safeTitle = String(title || 'Sem título')
        .replace(/[&<>"']/g, '')
        .slice(0, 24);
    const svg = `
        <svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'>
            <defs>
                <linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
                    <stop offset='0%' stop-color='#4338ca'/>
                    <stop offset='100%' stop-color='#7c3aed'/>
                </linearGradient>
            </defs>
            <rect width='100%' height='100%' fill='url(#g)'/>
            <text x='50%' y='42%' dominant-baseline='middle' text-anchor='middle' fill='#e2e8f0' font-size='40'>🎬</text>
            <text x='50%' y='58%' dominant-baseline='middle' text-anchor='middle' fill='#e2e8f0' font-size='16' font-family='Arial, sans-serif' font-weight='700'>${safeTitle}</text>
        </svg>
    `;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function setTrainingState(isTraining) {
    trainBtn.disabled = isTraining;
    trainBtn.style.opacity = isTraining ? '0.7' : '1';
    trainBtn.style.cursor = isTraining ? 'not-allowed' : 'pointer';
}

function clearTrainingTimeout() {
    if (trainingTimeoutId) {
        clearTimeout(trainingTimeoutId);
        trainingTimeoutId = null;
    }
}

function clearSaveWatchedTimeout() {
    if (saveWatchedTimeoutId) {
        clearTimeout(saveWatchedTimeoutId);
        saveWatchedTimeoutId = null;
    }
}

worker.onerror = (error) => {
    console.error('Erro no worker:', error);
    clearTrainingTimeout();
    setTrainingState(false);
    status.textContent = '❌ Erro ao carregar motor de recomendação. Recarregue a página.';
};

worker.onmessageerror = () => {
    clearTrainingTimeout();
    setTrainingState(false);
    status.textContent = '❌ Erro de comunicação com o worker.';
};

async function loadMovies() {
    try {
        const response = await fetch('/api/movies');
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        allMovies = await response.json();
        syncSelectionFromInput();
        displayMovies();
        refreshSelectedUserPanels();
    } catch (err) {
        console.error('Erro ao carregar filmes:', err);
    }
}

async function loadTrainingUsers() {
    try {
        const response = await fetch('/api/users');
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        trainingUsers = await response.json();
        populateUserSelect();
    } catch (error) {
        console.error('Erro ao carregar usuários:', error);
        status.textContent = '❌ Não foi possível carregar a lista de usuários de treino.';
    }
}

function populateUserSelect() {
    userSelect.innerHTML = '<option value="">Selecione um usuário</option>';
    trainingUsers.forEach(user => {
        const option = document.createElement('option');
        option.value = String(user.id);
        option.textContent = `${user.name || `Usuário ${user.id}`} (${user.age} anos)`;
        userSelect.appendChild(option);
    });
}

function renderSelectedUserMovies(user) {
    selectedUserMovies.innerHTML = '';
    if (!user) {
        selectedUserMovies.innerHTML = '<span class="helper-text">Nenhum usuário selecionado.</span>';
        return;
    }

    const watchedMovies = [...selectedWatchedIds]
        .map(id => allMovies.find(movie => movie.id === id))
        .filter(Boolean);

    if (!watchedMovies.length) {
        selectedUserMovies.innerHTML = '<span class="helper-text">Nenhum filme selecionado.</span>';
        return;
    }

    watchedMovies.forEach(movie => {
        const chip = document.createElement('span');
        chip.className = 'movie-chip';
        chip.textContent = movie.title;
        selectedUserMovies.appendChild(chip);
    });
}

function renderSelectedUserSummary(user) {
    selectedUserSummary.innerHTML = '';
    if (!user) {
        selectedUserSummary.innerHTML = '<span class="helper-text">Selecione um usuário para ver o resumo.</span>';
        return;
    }

    const watchedMovies = [...selectedWatchedIds]
        .map(id => allMovies.find(movie => movie.id === id))
        .filter(Boolean);

    const genreCount = {};
    watchedMovies.forEach(movie => {
        (movie.genres || []).forEach(genre => {
            genreCount[genre] = (genreCount[genre] || 0) + 1;
        });
    });

    const topGenres = Object.entries(genreCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([genre]) => GENRE_LABELS_PT[genre] || genre)
        .join(', ') || 'Sem dados';

    const displayName = user.name || `Usuário ${user.id}`;

    selectedUserSummary.innerHTML = `
        <div class="summary-card">
            <div class="summary-label">Nome</div>
            <div class="summary-value">${displayName}</div>
        </div>
        <div class="summary-card">
            <div class="summary-label">Idade</div>
            <div class="summary-value">${user.age} anos</div>
        </div>
        <div class="summary-card">
            <div class="summary-label">Filmes assistidos</div>
            <div class="summary-value">${watchedMovies.length}</div>
        </div>
        <div class="summary-card">
            <div class="summary-label">Gêneros preferidos</div>
            <div class="summary-value">${topGenres}</div>
        </div>
    `;
}

function getSelectedTrainingUser() {
    const selectedId = parseInt(userSelect.value, 10);
    if (!Number.isFinite(selectedId)) {
        return null;
    }
    return trainingUsers.find(item => item.id === selectedId) || null;
}

function refreshSelectedUserPanels() {
    const user = getSelectedTrainingUser();
    renderSelectedUserSummary(user);
    renderSelectedUserMovies(user);
}

async function persistSelectedUserWatched() {
    const user = getSelectedTrainingUser();
    if (!user) {
        return;
    }

    const watched = [...selectedWatchedIds]
        .sort((a, b) => a - b)
        .map(id => ({ id }));

    try {
        const response = await fetch(`/api/users/${user.id}/watched`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ watched }),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const payload = await response.json();
        if (payload?.user) {
            const userIndex = trainingUsers.findIndex(item => item.id === payload.user.id);
            if (userIndex >= 0) {
                trainingUsers[userIndex] = payload.user;
            }
        }

        status.textContent = '💾 Alterações do usuário salvas.';
    } catch (error) {
        console.error('Erro ao salvar filmes assistidos do usuário:', error);
        status.textContent = '❌ Não foi possível salvar as alterações do usuário.';
    }
}

function schedulePersistSelectedUserWatched() {
    const user = getSelectedTrainingUser();
    if (!user) {
        return;
    }
    clearSaveWatchedTimeout();
    saveWatchedTimeoutId = setTimeout(() => {
        persistSelectedUserWatched();
    }, 350);
}

function applyUserProfile(user) {
    ageInput.value = user.age;
    selectedWatchedIds.clear();
    (user.watched || []).forEach(item => selectedWatchedIds.add(item.id));
    syncInputFromSelection();
    displayMovies();
    renderSelectedUserSummary(user);
    renderSelectedUserMovies(user);
}

function parseWatchedInputToIds() {
    return watchedInput.value
        .split(',')
        .map(value => parseInt(value.trim(), 10))
        .filter(Number.isFinite);
}

function syncSelectionFromInput() {
    selectedWatchedIds.clear();
    parseWatchedInputToIds().forEach(id => selectedWatchedIds.add(id));
}

function syncInputFromSelection() {
    const sortedIds = [...selectedWatchedIds].sort((a, b) => a - b);
    watchedInput.value = sortedIds.join(',');
}

function resetInitialSelection() {
    selectedWatchedIds.clear();
    watchedInput.value = '';
}

function buildAgeBasedWatched(age) {
    const usersWithHistory = trainingUsers
        .filter(user => Number.isFinite(user?.age) && Array.isArray(user?.watched) && user.watched.length > 0)
        .sort((a, b) => Math.abs(a.age - age) - Math.abs(b.age - age))
        .slice(0, 5);

    if (!usersWithHistory.length) {
        return [];
    }

    const movieScores = new Map();
    usersWithHistory.forEach(user => {
        const weight = 1 / (1 + Math.abs(user.age - age));
        (user.watched || []).forEach(item => {
            if (!Number.isFinite(item?.id)) return;
            const current = movieScores.get(item.id) || 0;
            movieScores.set(item.id, current + weight);
        });
    });

    return [...movieScores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([id]) => ({ id }));
}

function displayMovies() {
    moviesGrid.innerHTML = '';
    allMovies.forEach(movie => {
        const card = document.createElement('div');
        card.className = 'movie-card';
        if (selectedWatchedIds.has(movie.id)) {
            card.classList.add('selected');
        }
        card.innerHTML = `
            <img src="${movie.poster}" alt="${movie.title}" class="movie-poster">
            <div class="movie-info">
                <div class="movie-title">${movie.title}</div>
                <div class="movie-rating">⭐ ${movie.rating}</div>
            </div>
        `;
        const cardImage = card.querySelector('.movie-poster');
        cardImage.onerror = () => {
            cardImage.onerror = null;
            cardImage.src = buildFallbackPoster(movie.title, 300, 450);
        };
        card.onclick = () => {
            if (selectedWatchedIds.has(movie.id)) {
                selectedWatchedIds.delete(movie.id);
                card.classList.remove('selected');
            } else {
                selectedWatchedIds.add(movie.id);
                card.classList.add('selected');
            }
            syncInputFromSelection();
            refreshSelectedUserPanels();
            schedulePersistSelectedUserWatched();
        };
        moviesGrid.appendChild(card);
    });
}

watchedInput.addEventListener('input', () => {
    syncSelectionFromInput();
    displayMovies();
    refreshSelectedUserPanels();
    schedulePersistSelectedUserWatched();
});

clearSelectionBtn.addEventListener('click', () => {
    selectedWatchedIds.clear();
    syncInputFromSelection();
    displayMovies();
    refreshSelectedUserPanels();
    schedulePersistSelectedUserWatched();
});

userSelect.addEventListener('change', () => {
    const selectedId = parseInt(userSelect.value, 10);
    const user = trainingUsers.find(item => item.id === selectedId);
    if (!user) {
        renderSelectedUserSummary(null);
        renderSelectedUserMovies(null);
        return;
    }

    applyUserProfile(user);
    if (isModelTrained) {
        runRecommendation();
    } else {
        status.textContent = 'ℹ️ Perfil aplicado. Clique em Treinar modelo para gerar recomendações.';
    }
});

worker.onmessage = e => {
    const { type, recommendations, stats, message } = e.data;
    if (type === 'training:start') {
        status.textContent = '⏳ Treinando modelo de IA...';
    }
    if (type === 'training:complete' || type === 'trainingComplete') {
        clearTrainingTimeout();
        setTrainingState(false);
        isModelTrained = true;
        status.textContent = `✅ Treinamento concluído (${stats?.movies || allMovies.length} filmes, ${stats?.users || 0} usuários).`;
        setTimeout(() => {
            status.textContent = '';
        }, 3000);
    }
    if (type === 'recommend') {
        displayRecommendations(recommendations);
    }
    if (type === 'error') {
        clearTrainingTimeout();
        setTrainingState(false);
        status.textContent = `❌ ${message}`;
    }
};

function displayRecommendations(recommendations) {
    results.innerHTML = '';
    if (!recommendations.length) {
        results.innerHTML = '<div class="empty-state">Nenhuma recomendação disponível</div>';
        return;
    }

    recommendations.forEach(r => {
        const movie = allMovies.find(m => m.id === r.id);
        if (!movie) return;

        const li = document.createElement('li');
        li.className = 'result-item';
        li.innerHTML = `
            <img src="${movie.poster}" alt="${movie.title}" class="result-image">
            <div class="result-title">${movie.title}</div>
            <div style="font-size:0.8rem;color:#666;margin-bottom:0.5rem;">${movie.year} • ⭐ ${movie.rating} • ${formatGenresPt(movie.genres)}</div>
            <div class="result-score">Compatibilidade: ${r.confidence ?? Math.round(r.score * 100)}%</div>
        `;
        const resultImage = li.querySelector('.result-image');
        resultImage.onerror = () => {
            resultImage.onerror = null;
            resultImage.src = buildFallbackPoster(movie.title, 180, 270);
        };
        results.appendChild(li);
    });
}

trainBtn.onclick = async () => {
    setTrainingState(true);
    status.textContent = '⏳ Treinando modelo de IA...';
    isModelTrained = false;
    clearTrainingTimeout();
    trainingTimeoutId = setTimeout(() => {
        setTrainingState(false);
        status.textContent = '❌ O treino demorou demais. Recarregue a página e tente novamente.';
    }, 12000);
    try {
        if (!trainingUsers.length) {
            await loadTrainingUsers();
        }
        if (!trainingUsers.length) {
            throw new Error('lista vazia');
        }
        if (!allMovies.length) {
            await loadMovies();
        }
        worker.postMessage({ action: 'train:model', users: trainingUsers, movies: allMovies });
    } catch (error) {
        clearTrainingTimeout();
        setTrainingState(false);
        status.textContent = `❌ Não foi possível carregar os usuários de treino (${error?.message || 'erro desconhecido'}).`;
    }
};

function runRecommendation() {
    if (!isModelTrained) {
        status.textContent = '⚠️ Treine o modelo antes de recomendar.';
        return;
    }

    const age = parseInt(ageInput.value, 10);
    if (!Number.isFinite(age) || age <= 0) {
        alert('Informe uma idade válida para recomendar.');
        return;
    }

    const watched = parseWatchedInputToIds().map(id => ({ id }));

    if (!watched.length) {
        const ageBasedWatched = buildAgeBasedWatched(age);
        if (!ageBasedWatched.length) {
            alert('Não foi possível montar recomendações por idade porque não há histórico suficiente de outros usuários.');
            return;
        }

        status.textContent = 'ℹ️ Nenhum filme informado. Usando perfil por idade com base em usuários semelhantes.';
        worker.postMessage({ action: 'recommend', user: { age, watched: ageBasedWatched } });
        return;
    }

    worker.postMessage({ action: 'recommend', user: { age, watched } });
}

testForm.onsubmit = e => {
    e.preventDefault();
    runRecommendation();
};

window.addEventListener('pageshow', () => {
    resetInitialSelection();
    displayMovies();
    userSelect.value = '';
    renderSelectedUserSummary(null);
    renderSelectedUserMovies(null);
});

window.addEventListener('beforeunload', () => {
    clearSaveWatchedTimeout();
});

resetInitialSelection();
loadMovies();
loadTrainingUsers();
renderSelectedUserSummary(null);
renderSelectedUserMovies(null);
