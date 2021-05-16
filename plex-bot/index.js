const {spawn} = require('child_process');
const {sprintf} = require('sprintf-js');
const cookie = require('cookie');
const dotenv = require('dotenv');
const fetch = require('isomorphic-fetch');
const fs = require('fs').promises;
const minimist = require('minimist');
const {promisify} = require('util');
const nameToImdb = promisify(require('name-to-imdb'));
const path = require('path');
const PlexAPI = require('plex-api');
const {Client} = require('@guaclive/guac.js');

dotenv.config()
const argv = minimist(process.argv.slice(2));

const historyPath = path.join(__dirname, 'history.json');
const history = require(historyPath);

const plex = new PlexAPI({
  hostname: process.env.PLEX_HOST,
  port: process.env.PLEX_PORT,
  https: true,
  username: process.env.PLEX_USER,
  password: process.env.PLEX_PASSWORD,
  managedUser: process.env.PLEX_MANAGED_USER && {
    name: process.env.PLEX_MANAGED_USER,
  },
  options: {
    identifier: 'plex-stream',
    deviceName: 'Stream',
    product: 'Stream',
  },
});

(async function() {
  const playlists = await loadPlaylists();
  const library = await plex.query(`/library/sections/${process.env.PLEX_LIBRARY_ID}/all`);
  const movies = library.MediaContainer.Metadata.filter(filterMetadata);
  console.log(`found ${movies.length} movies`);

  let previous = history.previous && !argv['ignore-previous'] && movies.find(({key}) => key === history.previous);
  if (!previous) {
    previous = movies[Math.floor(Math.random() * movies.length)];
  }

  let current;
  for await (let next of selectMovies(previous, movies, playlists)) {
    if (!current) {
      current = next;
      continue;
    }

    const {movie, streams} = current;
    current = next;

    console.log(`beginning ${movie.title} (${movie.year})`)
    try {
      await Promise.allSettled([
        logAsyncFn('playing movie', playMovie(movie, streams, next.movie)),
        logAsyncFn('updating guac', updateGuacTitle(movie)),
        logAsyncFn('notifying chat', notifyChat(movie)),
      ]);
    } catch (e) {
      console.log('error playing movie', err);
    }

    await new Promise(resolve => setTimeout(resolve, process.env.INTERMISSION_MS));
  }
})();

async function loadPlaylists() {
  const playlistsRes = await plex.query('/playlists');
  if (!playlistsRes.MediaContainer) {
    return {metadata: [], index: {}}
  }

  const metadata = await Promise.all(playlistsRes.MediaContainer.Metadata
    .map(({key}) => plex.query(key).then(res => res.MediaContainer.Metadata)));
  const index = metadata.flat().reduce((index, {key}) => ({...index, [key]: true}), {});
  return {metadata, index};
}

async function* selectMovies(previous, movies, playlists) {
  while (true) {
    const next = selectNext(previous, movies, playlists);
    await appendToHistory(next);

    const streams = await selectMediaStreams(next, movies);
    if (streams) {
      yield {
        movie: next,
        streams,
      };
    }
    previous = next;
  }
}

function selectNext(prev, movies, playlists) {
  // if the previous movie was in a playlist pick the next movie in that playlist
  let playlist = findPlaylist(prev, playlists);
  if (playlist) {
    const nextIndex = playlist.findIndex(({key}) => key === prev.key) + 1;
    if (nextIndex < playlist.length) {
      return playlist[nextIndex];
    }
  }

  const weights = generateWeights(prev, movies);
  const weightSum = weights.reduce((sum, [weight]) => sum + weight, 0);

  const rand = (1 - Math.pow(Math.random(), 10)) * weightSum;

  let runningSum = weightSum;
  const nextWeight = weights.find(([weight, i]) => {
    runningSum -= weight;
    return runningSum <= rand
      && movies[i].key !== prev.key
      && history[movies[i].key] === undefined;
  });
  const next = movies[nextWeight[1]]

  // if the selected movie exists in a playlist start from the beginning
  playlist = findPlaylist(next, playlists);
  if (playlist) {
    return playlist[0];
  }

  return next;
}

function findPlaylist(movie, playlists) {
  if (playlists.index[movie.key]) {
    return playlists.metadata.find(metadata => metadata.some(({key}) => key === movie.key));
  }
}

const toLookupTable = values => (values || []).reduce((t, {tag}) => ({...t, [tag]: true}), {});
const countMatches = (values, lookupTable) => (values || []).reduce((n, {tag}) => lookupTable[tag] ? n + 1 : n, 0);

function generateWeights(prev, movies) {
  const director = toLookupTable(prev.Director);
  const genre = toLookupTable(prev.Genre);
  const writer = toLookupTable(prev.Writer);
  const country = toLookupTable(prev.Country);
  const role = toLookupTable(prev.Role);
  const {year} = prev;

  return movies
    .map((movie, i) => {
      let weight = 0;
      weight += countMatches(movie.Director, director) * (+process.env.DIRECTOR_WEIGHT || 1);
      weight += countMatches(movie.Genre, genre) * (+process.env.GENRE_WEIGHT || 1);
      weight += countMatches(movie.Writer, writer) * (+process.env.WRITER_WEIGHT || 1);
      weight += countMatches(movie.Country, country) * (+process.env.COUNTRY_WEIGHT || 1);
      weight += countMatches(movie.Role, role) * (+process.env.ROLE_WEIGHT || 1);
      weight += (movie.year === year ? 1 : 0) * (+process.env.YEAR_WEIGHT || 1);
      weight += movie.rating * (+process.env.RATING_WEIGHT || 1);
      return [weight, i];
    })
    .sort(([a], [b]) => b - a);
}

async function selectMediaStreams(movie) {
  const record = await plex.query(movie.key);
  const media = record.MediaContainer.Metadata[0].Media
    .filter(filterMedia)
    .sort((a, b) => b.bitrate - a.bitrate);

  for (m of media) {
    const {Stream, file} = m.Part[0];
    const video = Stream.find(({streamType}) => streamType === 1);

    const audioTracks = Stream.filter(({streamType, languageCode}) => streamType === 2);
    const audio = audioTracks.length === 1 ? audioTracks[0] : audioTracks.find(({streamType, languageCode}) => languageCode === 'eng');

    if (video && audio) {
      return {video, audio, file};
    }
  }
}

const filterMedia = media => (
  media.bitrate >= process.env.MIN_BITRATE &&
  media.bitrate <= process.env.MAX_BITRATE &&
  media.height >= process.env.MIN_RESOLUTION &&
  media.height <= process.env.MAX_RESOLUTION
);

const filterMetadata = ({type, Media, year, rating}) => (
  type === 'movie' &&
  Media.some(filterMedia) &&
  year >= process.env.MIN_YEAR &&
  year <= process.env.MAX_YEAR &&
  rating >= process.env.MIN_RATING &&
  rating <= process.env.MAX_RATING
);

function playMovie(movie, {audio, video, file}, nextMovie) {
  const title = `${movie.title} (${movie.year}) • ${nextMovie.title} (${nextMovie.year})`;
  const titleDrawText = formatDrawText(title, 10, 10);

  const now = new Date();
  const timestamp = sprintf("%02d:%02d %s", now.getHours(), now.getMinutes(), process.env.TIME_ZONE);
  const timeDrawText = formatDrawText(timestamp, 10, 36)

  const keyInterval = Math.round(video.frameRate) * 2;

  const options = [
    '-re',
    '-i', file,
    '-vf', `${titleDrawText}, ${timeDrawText}`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', process.env.ENCODER_PRESET || 'veryfast',
    '-tune', process.env.ENCODER_TUNE || 'zerolatency',
    '-fflags', '+igndts',
    '-fflags', '+genpts',
    '-async', '1',
    '-vsync', '1',
    '-map', `0:${video.index}`,
    '-map', `0:${audio.index}`,
    '-b:v', '6000k',
    '-maxrate', '6000k',
    '-x264-params', `keyint=${keyInterval};min-keyint=${keyInterval};no-scenecut`,
    '-c:a', 'aac',
    '-strict', '-2',
    '-ar', '44100',
    '-b:a', '160k',
    '-ac', '2',
    '-bufsize', '7000k',
    '-flvflags', 'no_duration_filesize',
    '-f', 'flv', process.env.GUAC_INGEST,
  ];
  const ffmpeg = spawn('ffmpeg', options);
  ffmpeg.stdout.pipe(process.stdout);
  ffmpeg.stderr.pipe(process.stderr);

  return new Promise((resolve, reject) => {
    ffmpeg.on('close', resolve);
    ffmpeg.on('error', reject);
  });
}

function formatDrawText(text, x, y) {
  const sanitizedTitle = text.replace(/(\:)/g, '\\$1').replace(/\'/g, '');
  return `drawtext=text='${sanitizedTitle}': fontcolor=gray@0.4: fontsize=18: x=${x}: y=${y}`
}

async function appendToHistory(movie) {
  history.previous = movie.key;
  history[movie.key] = movie.title;
  await fs.writeFile(historyPath, JSON.stringify(history, null, 2));
}

async function updateGuacTitle(movie) {
  const accessToken = await createGuacToken();
  const res = await fetch('https://api.guac.live/channel/setTitle', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({title: `${movie.title} (${movie.year})`}),
  });
  return await res.text()
}

async function createGuacToken() {
  const res = await fetch('https://api.guac.live/auth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username: process.env.GUAC_USER,
      password: process.env.GUAC_PASSWORD,
    }),
  });
  const {jwtToken} = await res.json();
  return jwtToken;
}

async function notifyChat(movie) {
  let c = new Client({
    clientType: 'user'
  });
  c.connect(await createGuacToken(), process.env.GUAC_USER);

  const [imdbUrl] = await Promise.all([
    getImdbUrl(movie),
    new Promise((resolve, reject) => {
      c.on('join', resolve);
      c.on('error', reject);
    }),
  ]);

  const imdbInfo = imdbUrl ? ` - ${imdbUrl} (${movie.rating})` : '';
  const emotes = process.env.GUAC_EMOTES && process.env.GUAC_EMOTES.split(",")
  const selectedEmote = emotes ? emotes[Math.floor(Math.random() * emotes.length)] : "";
  const data = `${selectedEmote} ${movie.title} (${movie.year})${imdbInfo} started at ${process.env.GUAC_URL}`;
  c.say(data);
  c.io.disconnect();
}

async function getImdbUrl(movie) {
  try {
    const id = await nameToImdb({
      name: movie.title,
      year: movie.year,
    })
    return id && id.startsWith('tt') && `imdb.com/title/${id}`;
  } catch (e) {}
}

async function logAsyncFn(action, fn) {
  console.log(action);
  let res;
  try {
    res = await fn;
  } catch (e) {
    console.log(`error ${action} ${e}`);
    throw e;
  }
  console.log(`finished ${action}`);
  return res;
}
