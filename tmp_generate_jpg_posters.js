const fs = require('fs');
const path = require('path');
const https = require('https');

const moviesPath = path.join('data', 'movies_tmdb.json');
const postersDir = path.join('data', 'posters');

if (!fs.existsSync(postersDir)) {
  fs.mkdirSync(postersDir, { recursive: true });
}

const movies = JSON.parse(fs.readFileSync(moviesPath, 'utf8'));

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlink(destination, () => {
          download(response.headers.location, destination).then(resolve).catch(reject);
        });
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(destination, () => reject(new Error(`HTTP ${response.statusCode}`)));
        response.resume();
        return;
      }

      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (error) => {
      file.close();
      fs.unlink(destination, () => reject(error));
    });
  });
}

(async () => {
  for (const movie of movies) {
    const fileName = `movie-${movie.id}.jpg`;
    const output = path.join(postersDir, fileName);
    const seed = encodeURIComponent(`${movie.id}-${movie.title}`);
    const imageUrl = `https://picsum.photos/seed/${seed}/500/750`;

    await download(imageUrl, output);
    movie.poster = `data/posters/${fileName}`;
  }

  fs.writeFileSync(moviesPath, JSON.stringify(movies, null, 2) + '\n', 'utf8');
  console.log(`Posters JPG gerados: ${movies.length}`);
})();
