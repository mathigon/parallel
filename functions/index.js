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
const LEVELS = ['year7', 'year8', 'year9',  'year10', 'year11'];
const LEVEL_NAMES = {year7: 'Year 7', year8: 'Year 8', year9: 'Year 9', year10: 'Year 10', year11: 'Year 11'};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BADGE_NAMES = {ancient: 'Ancient Hero', geometry: 'Geometry', historic: 'Historic Hero', number: 'Number', modern: 'Modern Hero'};

const PAGES_MAP = {};
for (let l of LEVELS) {
  for (let [i, p] of PAGES[l].entries()) {
    const date = new Date(p.available);
    p.available = +date;
    p.deadline = +(new Date(p.deadline));
    p.date = `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
    p.year = +l.slice(4);
    p.index = PAGES[l].length - i;
    PAGES_MAP[p.url] = p;
  }
}

function scoreClass(score) {
  if (score >= 90) return 'tesseract';
  if (score >= 70) return 'cube';
  if (score >= 50) return 'square';
  if (score >= 20) return 'line';
  return 'point';
}

function error(res, code) {
  res.status(code);
  return res.render('error', {code});
}

function letterOrder(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
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
  res.locals.pages = {};
  res.locals.now = Date.now();
  res.locals.levels = LEVELS;
  res.locals.levelNames = LEVEL_NAMES;
  res.locals.badgeNames = BADGE_NAMES;
  res.locals.path = req.path.replace(/\/$/, '');
  res.locals.scoreClass = scoreClass;

  if (req.user && req.user.showWelcomeMsg) {
    firebase.database().ref(`users/${req.user.uid}`) // async
        .update({showWelcomeMsg: false})
        .catch(() => console.error('Failed to update welcome msg', req.user.uid));
  }

  for (let l of LEVELS) {
    res.locals.pages[l] =
        PAGES[l].filter(p => (res.locals.now >= p.available));
  }

  next();
});


// -----------------------------------------------------------------------------
// Request Handlers

app.get('/', (req, res) => res.render('home'));
app.get('/contact', (req, res) => res.render('contact'));

for (let p of ['about', 'introduction', 'parents', 'teachers', 'terms-and-conditions', 'hints-tips', 'troubleshooting']) {
  const content = fs.readFileSync(path.join(__dirname, `build/${p}.html`));
  app.get('/' + p, (req, res) => res.render('_layout', {content}));
}

app.get('/account', (req, res) => {
  if (!req.user) return error(res, 401);
  res.render('account');
});

app.get('/badges', (req, res) => {
  if (!req.user) return error(res, 401);
  res.render('badges', {showAllBadges: ('reveal' in req.query)});
});

app.get('/signup', (req, res) => {
  if (req.user) res.redirect('/');
  res.render('signup');
});

async function getDashboardData(req) {
  const dashboard = {students: {}, pages: {}, error: null};

  for (let l of LEVELS) {
    dashboard.students[l] = [];
    dashboard.pages[l] = PAGES[l].filter((p) => Date.now() >= p.available);
  }

  const students = await user.getAllStudents(req.user.code);
  const studentKeys = Object.keys(students)
      .sort((a, b) => letterOrder(students[a].last, students[b].last));

  for (let s of studentKeys) {
    if (!students[s].answers) students[s].answers = {};
    students[s].uid = s;
    dashboard.students[students[s].level || 'year7'].push(students[s]);
  }

  if (!studentKeys.length)
    dashboard.error = 'So far, no students have signed up with your class code.';

  return dashboard;
}

app.get('/dashboard', async function(req, res) {
  if (!req.user) return error(res, 401);
  if (!req.user.code) return error(res, 403);

  const dashboard = await getDashboardData(req);
  res.render('dashboard', {dashboard})
});

app.get('/dashboard.csv', async function(req, res) {
  if (!req.user) return error(res, 401);
  if (!req.user.code) return error(res, 403);

  const dashboard = await getDashboardData(req);
  const results = [];

  for (let l of LEVELS) {
    if (!dashboard.students[l].length) continue;

    results.push(LEVEL_NAMES[l]);

    const titles = ['Name'];
    for (const p of dashboard.pages[l]) titles.push('PG' + p.index);
    results.push(titles.join(','));

    for (const s of dashboard.students[l]) {
      const row = [`"${s.first} ${s.last}"`];
      for (const p of dashboard.pages[l]) {
        const answers = s.answers[p.url];
        row.push(answers ? (answers.score || 0) : 0);
      }
      results.push(row.join(','));
    }

    results.push('', '');
  }

  const response = results.join('\n');

  res.setHeader('Content-disposition', 'attachment; filename=parallel-data.csv');
  res.set('Content-Type', 'text/csv');
  res.status(200).send(response);
});

app.post('/remove-student', async function(req,res) {
  if (!req.user) return error(res, 401);
  if (!req.user.code) return error(res, 403);

  const user = firebase.database().ref(`users/${req.body.id}`);

  const teacherCode = (await user.once('value')).val().teacherCode;
  if (teacherCode !== req.user.code) return error(res, 403);

  await user.update({teacherCode: null});
  res.sendStatus(200);
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
    for (let b of BADGES[req.user.level]) {
      if (b.score <= req.user.points && req.user.badges.indexOf(b.id) < 0) {
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
