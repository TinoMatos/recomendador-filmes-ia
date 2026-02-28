const fs = require('fs');
const path = require('path');

const baseUrl = process.env.API_URL || 'http://localhost:3001';
const moviesArg = process.argv[2] || 'data/movies_tmdb.json';
const usersArg = process.argv[3] || 'data/users.json';

function readJsonFile(filePath) {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Arquivo não encontrado: ${fullPath}`);
  }
  const raw = fs.readFileSync(fullPath, 'utf8');
  return JSON.parse(raw);
}

async function postBulk(endpoint, data) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error || `Erro HTTP ${response.status}`);
  }
  return payload;
}

async function run() {
  const movies = readJsonFile(moviesArg);
  const users = readJsonFile(usersArg);

  if (!Array.isArray(movies)) {
    throw new Error('O arquivo de filmes precisa ser um array JSON.');
  }
  if (!Array.isArray(users)) {
    throw new Error('O arquivo de usuários precisa ser um array JSON.');
  }

  const moviesResult = await postBulk('/api/movies/bulk', movies);
  const usersResult = await postBulk('/api/users/bulk', users);

  console.log(`✅ Filmes importados: ${moviesResult.imported}`);
  console.log(`✅ Usuários importados: ${usersResult.imported}`);
}

run().catch((error) => {
  console.error(`❌ Falha na importação: ${error.message}`);
  process.exit(1);
});
