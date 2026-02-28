const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');

const PORT = Number(process.env.PORT || 3001);
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'movies.db');
const DB_CLIENT = process.env.DB_CLIENT || (process.env.DATABASE_URL ? 'postgres' : 'sqlite');
const DATABASE_URL = process.env.DATABASE_URL || '';

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function safeNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function createStore() {
  if (DB_CLIENT === 'postgres') {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL não configurada para PostgreSQL.');
    }

    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();

    return {
      provider: 'postgres',
      async init() {
        await client.query(`
          CREATE TABLE IF NOT EXISTS movies (
            id INTEGER PRIMARY KEY,
            title TEXT NOT NULL,
            year INTEGER,
            rating DOUBLE PRECISION,
            poster TEXT,
            genres_json JSONB NOT NULL DEFAULT '[]'::jsonb
          );

          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            name TEXT,
            age INTEGER NOT NULL
          );

          CREATE TABLE IF NOT EXISTS user_watched (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
            PRIMARY KEY (user_id, movie_id)
          );
        `);
      },
      async countMovies() {
        const result = await client.query('SELECT COUNT(*)::int AS count FROM movies');
        return result.rows[0]?.count || 0;
      },
      async countUsers() {
        const result = await client.query('SELECT COUNT(*)::int AS count FROM users');
        return result.rows[0]?.count || 0;
      },
      async upsertMovies(movies = []) {
        await client.query('BEGIN');
        try {
          for (const movie of movies) {
            const id = safeNumber(movie?.id);
            if (!Number.isFinite(id)) continue;
            await client.query(
              `
                INSERT INTO movies (id, title, year, rating, poster, genres_json)
                VALUES ($1, $2, $3, $4, $5, $6::jsonb)
                ON CONFLICT (id) DO UPDATE SET
                  title = EXCLUDED.title,
                  year = EXCLUDED.year,
                  rating = EXCLUDED.rating,
                  poster = EXCLUDED.poster,
                  genres_json = EXCLUDED.genres_json
              `,
              [
                id,
                String(movie?.title || `Filme ${id}`),
                safeNumber(movie?.year),
                safeNumber(movie?.rating),
                movie?.poster ? String(movie.poster) : null,
                JSON.stringify(Array.isArray(movie?.genres) ? movie.genres : []),
              ]
            );
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      },
      async upsertUsers(users = []) {
        await client.query('BEGIN');
        try {
          for (const user of users) {
            const id = safeNumber(user?.id);
            const age = safeNumber(user?.age);
            if (!Number.isFinite(id) || !Number.isFinite(age)) continue;

            await client.query(
              `
                INSERT INTO users (id, name, age)
                VALUES ($1, $2, $3)
                ON CONFLICT (id) DO UPDATE SET
                  name = EXCLUDED.name,
                  age = EXCLUDED.age
              `,
              [id, user?.name ? String(user.name) : `Usuário ${id}`, age]
            );

            await client.query('DELETE FROM user_watched WHERE user_id = $1', [id]);

            const watched = Array.isArray(user?.watched) ? user.watched : [];
            for (const item of watched) {
              const movieId = safeNumber(item?.id);
              if (!Number.isFinite(movieId)) continue;
              await client.query(
                `
                  INSERT INTO user_watched (user_id, movie_id)
                  VALUES ($1, $2)
                  ON CONFLICT (user_id, movie_id) DO NOTHING
                `,
                [id, movieId]
              );
            }
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      },
      async getMovies() {
        const result = await client.query('SELECT id, title, year, rating, poster, genres_json FROM movies ORDER BY id');
        return result.rows.map((row) => ({
          id: row.id,
          title: row.title,
          year: row.year,
          rating: row.rating,
          poster: row.poster,
          genres: Array.isArray(row.genres_json) ? row.genres_json : JSON.parse(row.genres_json || '[]'),
        }));
      },
      async getUsers() {
        const result = await client.query(`
          SELECT u.id, u.name, u.age, uw.movie_id
          FROM users u
          LEFT JOIN user_watched uw ON uw.user_id = u.id
          ORDER BY u.id, uw.movie_id
        `);

        const usersById = new Map();
        result.rows.forEach((row) => {
          if (!usersById.has(row.id)) {
            usersById.set(row.id, {
              id: row.id,
              name: row.name,
              age: row.age,
              watched: [],
            });
          }
          if (Number.isFinite(row.movie_id)) {
            usersById.get(row.id).watched.push({ id: row.movie_id });
          }
        });
        return [...usersById.values()];
      },
      async close() {
        await client.end();
      },
    };
  }

  const sqlite = new DatabaseSync(DB_PATH);

  return {
    provider: 'sqlite',
    async init() {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS movies (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          year INTEGER,
          rating REAL,
          poster TEXT,
          genres_json TEXT NOT NULL DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY,
          name TEXT,
          age INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_watched (
          user_id INTEGER NOT NULL,
          movie_id INTEGER NOT NULL,
          PRIMARY KEY (user_id, movie_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE
        );
      `);
    },
    async countMovies() {
      return sqlite.prepare('SELECT COUNT(*) AS count FROM movies').get().count;
    },
    async countUsers() {
      return sqlite.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    },
    async upsertMovies(movies = []) {
      const statement = sqlite.prepare(`
        INSERT INTO movies (id, title, year, rating, poster, genres_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          year = excluded.year,
          rating = excluded.rating,
          poster = excluded.poster,
          genres_json = excluded.genres_json
      `);

      sqlite.exec('BEGIN');
      try {
        movies.forEach((movie) => {
          const id = safeNumber(movie?.id);
          if (!Number.isFinite(id)) return;
          statement.run(
            id,
            String(movie?.title || `Filme ${id}`),
            safeNumber(movie?.year),
            safeNumber(movie?.rating),
            movie?.poster ? String(movie.poster) : null,
            JSON.stringify(Array.isArray(movie?.genres) ? movie.genres : [])
          );
        });
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    async upsertUsers(users = []) {
      const upsertUser = sqlite.prepare(`
        INSERT INTO users (id, name, age)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          age = excluded.age
      `);

      const deleteWatched = sqlite.prepare('DELETE FROM user_watched WHERE user_id = ?');
      const insertWatched = sqlite.prepare(`
        INSERT OR IGNORE INTO user_watched (user_id, movie_id)
        VALUES (?, ?)
      `);

      sqlite.exec('BEGIN');
      try {
        users.forEach((user) => {
          const id = safeNumber(user?.id);
          const age = safeNumber(user?.age);
          if (!Number.isFinite(id) || !Number.isFinite(age)) return;

          upsertUser.run(id, user?.name ? String(user.name) : `Usuário ${id}`, age);
          deleteWatched.run(id);

          const watched = Array.isArray(user?.watched) ? user.watched : [];
          watched.forEach((item) => {
            const movieId = safeNumber(item?.id);
            if (!Number.isFinite(movieId)) return;
            insertWatched.run(id, movieId);
          });
        });
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    async getMovies() {
      const rows = sqlite.prepare('SELECT id, title, year, rating, poster, genres_json FROM movies ORDER BY id').all();
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        year: row.year,
        rating: row.rating,
        poster: row.poster,
        genres: JSON.parse(row.genres_json || '[]'),
      }));
    },
    async getUsers() {
      const rows = sqlite.prepare(`
        SELECT u.id, u.name, u.age, uw.movie_id
        FROM users u
        LEFT JOIN user_watched uw ON uw.user_id = u.id
        ORDER BY u.id, uw.movie_id
      `).all();

      const usersById = new Map();
      rows.forEach((row) => {
        if (!usersById.has(row.id)) {
          usersById.set(row.id, {
            id: row.id,
            name: row.name,
            age: row.age,
            watched: [],
          });
        }
        if (Number.isFinite(row.movie_id)) {
          usersById.get(row.id).watched.push({ id: row.movie_id });
        }
      });

      return [...usersById.values()];
    },
    async close() {
      sqlite.close();
    },
  };
}

async function seedFromJsonFiles(store) {
  const moviesPath = path.join(DATA_DIR, 'movies_tmdb.json');
  const usersPath = path.join(DATA_DIR, 'users.json');

  const movies = fs.existsSync(moviesPath)
    ? JSON.parse(fs.readFileSync(moviesPath, 'utf8'))
    : [];
  const users = fs.existsSync(usersPath)
    ? JSON.parse(fs.readFileSync(usersPath, 'utf8'))
    : [];

  if (Array.isArray(movies) && movies.length > 0) {
    await store.upsertMovies(movies);
  }
  if (Array.isArray(users) && users.length > 0) {
    await store.upsertUsers(users);
  }
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10 * 1024 * 1024) {
        reject(new Error('Payload muito grande (máximo 10MB).'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const relativePath = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(relativePath).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(ROOT_DIR, normalized);

  if (!filePath.startsWith(ROOT_DIR)) {
    writeJson(res, 403, { error: 'Acesso negado.' });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        writeJson(res, 404, { error: 'Arquivo não encontrado.' });
        return;
      }
      writeJson(res, 500, { error: 'Erro ao carregar arquivo estático.' });
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

async function startServer() {
  const store = await createStore();
  await store.init();

  const movieCount = await store.countMovies();
  const userCount = await store.countUsers();
  if (movieCount === 0 || userCount === 0) {
    await seedFromJsonFiles(store);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;

    try {
      if (req.method === 'GET' && pathname === '/api/movies') {
        writeJson(res, 200, await store.getMovies());
        return;
      }

      if (req.method === 'GET' && pathname === '/api/users') {
        writeJson(res, 200, await store.getUsers());
        return;
      }

      const watchedRouteMatch = pathname.match(/^\/api\/users\/(\d+)\/watched$/);
      if (req.method === 'PUT' && watchedRouteMatch) {
        const userId = safeNumber(watchedRouteMatch[1]);
        if (!Number.isFinite(userId)) {
          writeJson(res, 400, { error: 'ID de usuário inválido.' });
          return;
        }

        const body = await readJsonBody(req);
        if (!body || !Array.isArray(body.watched)) {
          writeJson(res, 400, { error: 'Envie um objeto com watched: [{ id }].' });
          return;
        }

        const users = await store.getUsers();
        const existingUser = users.find((user) => user.id === userId);
        if (!existingUser) {
          writeJson(res, 404, { error: 'Usuário não encontrado.' });
          return;
        }

        const normalizedIds = [...new Set(
          body.watched
            .map((item) => safeNumber(item?.id))
            .filter(Number.isFinite)
        )];

        const updatedUser = {
          ...existingUser,
          watched: normalizedIds.map((id) => ({ id })),
        };

        await store.upsertUsers([updatedUser]);
        writeJson(res, 200, { ok: true, user: updatedUser });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/movies/bulk') {
        const body = await readJsonBody(req);
        if (!Array.isArray(body)) {
          writeJson(res, 400, { error: 'Envie um array de filmes.' });
          return;
        }
        await store.upsertMovies(body);
        writeJson(res, 200, { ok: true, imported: body.length });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/users/bulk') {
        const body = await readJsonBody(req);
        if (!Array.isArray(body)) {
          writeJson(res, 400, { error: 'Envie um array de usuários.' });
          return;
        }
        await store.upsertUsers(body);
        writeJson(res, 200, { ok: true, imported: body.length });
        return;
      }

      serveStatic(req, res, pathname);
    } catch (error) {
      writeJson(res, 500, { error: error?.message || 'Erro interno.' });
    }
  });

  const shutdown = async () => {
    await store.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT} (db=${store.provider})`);
  });
}

startServer().catch((error) => {
  console.error(`Falha ao iniciar servidor: ${error?.message || error}`);
  process.exit(1);
});
