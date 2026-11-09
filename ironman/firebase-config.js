// firebase-config.js — Jax 140.6 at https://mypacezone.com/ironman/
// Shares MyPaceZone's Firebase PROJECT, never its data: every collection this
// app touches starts with "imjax_" (imjax_users, imjax_approvedUsers, ...).
// The marathon app's "users", "approvedUsers", "signupRequests", "groups" are never read or written.

const USE_LOCAL_STORE = false;
const COLLECTION_PREFIX = "imjax_";

// MyPaceZone's public web config (same values as the marathon app's firebase-config.js)
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCV_tkFRLz_UHU1rTAttNBfk0NEc0u5-Ac",
  authDomain:        "hr-train-f33bb.firebaseapp.com",
  projectId:         "hr-train-f33bb",
  storageBucket:     "hr-train-f33bb.firebasestorage.app",
  messagingSenderId: "451674127337",
  appId:             "1:451674127337:web:d7f150622ecca9d99aa978"
};

const FORMSPREE_ID = null;
const APP_URL = "https://mypacezone.com/ironman/";

// Strava: off until JB decides. Option: reuse MyPaceZone's Strava app (its callback
// domain mypacezone.com already covers /ironman/). Copy clientId/clientSecret from the
// marathon app's App.js. Leave null to log workouts by hand.
const STRAVA_CONFIG = {
  clientId:     null,
  clientSecret: null,
  redirectUri:  "https://mypacezone.com/ironman/",
  scope:        "activity:read_all"
};

// Coach login. JB: edit this on GitHub before telling anyone the link.
// While it starts with CHANGE_ME, coach login is disabled.
const ADMIN = {
  password: "CHANGE_ME_before_upload",
  id:       "coach",
  name:     "Coach JB",
  admin:    true
};
