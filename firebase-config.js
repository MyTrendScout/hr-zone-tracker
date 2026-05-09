// firebase-config.js

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCV_tkFRLz_UHU1rTAttNBfk0NEc0u5-Ac",
  authDomain:        "hr-train-f33bb.firebaseapp.com",
  projectId:         "hr-train-f33bb",
  storageBucket:     "hr-train-f33bb.firebasestorage.app",
  messagingSenderId: "451674127337",
  appId:             "1:451674127337:web:d7f150622ecca9d99aa978"
};

// ─────────────────────────────────────────────────────────────
// Formspree — free email notifications when someone requests access.
// 1. Go to https://formspree.io  →  New Form  →  copy the 8-char ID
//    It looks like: https://formspree.io/f/abcd1234  →  ID is "abcd1234"
// 2. Paste that ID below (replace the placeholder).
// Set to null to disable notifications (requests still save to Firebase).
// ─────────────────────────────────────────────────────────────
const FORMSPREE_ID = "mwvyrzje";

// ─────────────────────────────────────────────────────────────
// Your admin account — always has access, no approval needed.
// Change the password and name to your own.
// Everyone else signs up through the app and you approve them.
// ─────────────────────────────────────────────────────────────

const ADMIN = {
  password: "BoatHouse3904",
  id:       "admin",
  name:     "RunMaster",
  admin:    true
};
