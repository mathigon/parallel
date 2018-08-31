// =============================================================================
// Parallel Project – Node App
// =============================================================================


const fs = require('fs');
const path = require('path');
const functions = require('firebase-functions');
const firebase = require('firebase-admin');
const express = require('express');
const user = require('./utilities/user');

const BADGES = require('./build/badges.json');
const PAGES = require('./build/pages.json');
const LEVELS = ['year7', 'year8', 'year9'];
const LEVEL_NAMES = {year7: 'Year 7', year8: 'Year 8', year9: 'Year 9'};

const PAGES_MAP = {};
for (let l of LEVELS) {
  for (let p of PAGES[l]) {
    p.available = +(new Date(p.available));
    p.deadline = +(new Date(p.deadline));
    PAGES_MAP[p.url] = p;
  }
}

const BADGES_MAP = {};
for (let l of LEVELS) {
  for (let b of BADGES[l]) {
    BADGES_MAP[b.id] = b;
  }
}

function scoreName(score) {
  if (score >= 90) return 'Tesseract';
  if (score >= 70) return 'Cube';
  if (score >= 50) return 'Square';
  if (score >= 20) return 'Line';
  return 'Point';
}

function userPoints(user) {
  return PAGES[user.level].map(p => (user.answers[p.url] || {}).score || 0)
      .reduce((a, b) => a + b, 0);
}

function error(res, code) {
  res.status(code);
  return res.render('error', {code});
}


// -----------------------------------------------------------------------------
// Set up Express App

firebase.initializeApp({
  credential: firebase.credential.cert(require('./build/service-account.json')),
  databaseURL: `https://parallel-cf800.firebaseio.com`,
});

const app = express();
app.set('view engine', 'pug');

app.use(user.getActiveUser);

app.use((req, res, next) => {
  res.locals.user = req.user;
  res.locals.badges = BADGES;
  res.locals.badgesMap = BADGES_MAP;
  res.locals.pages = {};
  res.locals.now = Date.now();
  res.locals.levels = LEVELS;
  res.locals.levelNames = LEVEL_NAMES;
  res.locals.path = req.path.replace(/\/$/, '');
  res.locals.scoreName = scoreName;
  res.locals.scoreClass = (s) => scoreName(s).toLowerCase();

  for (let l of LEVELS) {
    res.locals.pages[l] =
        PAGES[l].filter(p => (res.locals.now >= p.available)).slice(0, 5);
  }

  next();
});


// -----------------------------------------------------------------------------
// Request Handlers

app.get('/', (req, res) => res.render('home'));
app.get('/contact', (req, res) => res.render('contact'));

for (let p of ['about', 'introduction', 'parents', 'teachers', 'terms-and-conditions']) {
  const content = fs.readFileSync(path.join(__dirname, `build/${p}.html`));
  app.get('/' + p, (req, res) => res.render('_layout', {content}));
}

app.get('/account', (req, res) => {
  if (!req.user) return error(res, 401);
  res.render('account');
});

app.get('/badges', (req, res) => {
  if (!req.user) return error(res, 401);
  const showAllBadges = ('reveal' in req.query);
  res.render('badges', {showAllBadges});
});

app.get('/signup', (req, res) => {
  if (req.user) res.redirect('/');
  res.render('signup');
});

app.get('/dashboard', async function(req, res) {
  if (!req.user) return error(res, 401);
  if (!req.user.code) return error(res, 403);

  const dashboard = {students: {}, pages: {}, error: null};

  for (let l of LEVELS) {
    dashboard.students[l] = [];
    dashboard.pages[l] = PAGES[l];  // TODO filter by active
  }

  const students = await user.getAllStudents(req.user.code);
  const studentKeys = Object.keys(students);

  for (let s of studentKeys) {
    if (!students[s].answers) students[s].answers = {};
    dashboard.students[students[s].level || 'year7'].push(students[s]);
  }

  if (!studentKeys.length)
    dashboard.error = 'So far, no students have signed up with your class code.';

  res.render('dashboard', {dashboard})
});

app.get('/:pid', (req, res, next) => {
  const pid = req.params.pid;
  if (!PAGES_MAP[pid]) return next();

  const body = fs.readFileSync(path.join(__dirname, `build/${pid}.html`))
      .toString().replace(/<h1.*<\/h1>/, '');

  const answers = req.user ? (req.user.answers[pid] || {}) : {};
  const userData = {answers, uid: req.user ? req.user.uid : '',
    submitted: ('reveal' in req.query) || answers.submitted || false};

  let newBadge = null;
  if (req.user && !req.user.code) {
    const points = userPoints(req.user);
    for (let b of BADGES[req.user.level]) {
      if (b.score <= points && req.user.badges.indexOf(b.id) < 0) {
        req.user.badges.push(b.id);
        newBadge = b;
        firebase.database().ref(`users/${req.user.uid}`) // async
            .update({badges: req.user.badges.join(',')})
            .catch(() => console.error('Failed to update badges', req.user.uid));
      }
    }
  }

  res.render('parallelogram', {pid, body, page: PAGES_MAP[pid], userData,
    newBadge});
});

app.use((req, res) => error(res, 404));
app.use((e, req, res, next) => {
  console.error(e);
  error(res, 500);
});

exports.app = functions.https.onRequest(app);