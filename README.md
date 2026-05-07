# HR Zone Tracker

A private training app for a small group of runners. Runs on GitHub Pages (free). Data syncs to Firebase (free).

---

## Features

- Password-protected login (one per person)
- Profile: name, age, height, weight, resting HR
- HR zones via estimated formula **or** real field test
- Race goal with safety validator (flags unrealistic targets)
- Live predicted marathon finish using Riegel's formula — updates as you train
- Weekly training plan (zone-based, adapts by phase)
- Re-test reminder every 4 weeks
- Workout log: pace, distance, avg HR, weight, notes
- Weight trend — flags if dropping too fast (fueling check)
- **Command Center** (admin only) — see all athletes at a glance

---

## Setup (one-time, ~10 minutes)

### 1. Create a Firebase project (free)

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Click **Add project** → give it a name (e.g. `hr-zone-tracker`)
3. Disable Google Analytics if you don't need it → **Create project**

### 2. Add a web app and get your config

1. In your project, click the **</>** (Web) icon
2. Register the app with a nickname → click **Register app**
3. Copy the `firebaseConfig` object — you'll need it in the next step

### 3. Enable Firestore

1. In the left sidebar: **Build → Firestore Database**
2. Click **Create database**
3. Choose **Start in test mode** → pick a region → **Enable**

### 4. Set Firestore rules (keeps data private)

In Firestore → **Rules** tab, paste this and publish:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if true;
    }
  }
}
```

> This is acceptable for a small private friend group. The app-level password is your first line of defence.

### 5. Update firebase-config.js

Open `firebase-config.js` and replace the placeholder values with your real config:

```js
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSy...",
  authDomain:        "your-project.firebaseapp.com",
  projectId:         "your-project",
  storageBucket:     "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:abc123"
};
```

Also update the `USERS` object with your chosen passwords and names:

```js
const USERS = {
  "yourActualPassword": { id: "user1", name: "John", admin: true  },
  "friendPassword1":    { id: "user2", name: "Sara", admin: false },
  ...
};
```

**Security note:** passwords are visible in source code because this is a GitHub Pages app with no backend. Use passwords you don't use elsewhere and share them only by direct message.

### 6. Upload to GitHub and enable Pages

1. Create a repo called `hr-zone-tracker` on GitHub (can be public or private)
2. Upload all files: `index.html`, `styles.css`, `App.js`, `firebase-config.js`, `README.md`
3. Go to **Settings → Pages → Source: Deploy from branch → main**
4. Your site will be live at `https://yourusername.github.io/hr-zone-tracker`

---

## Using the app

**First visit:** you'll be guided through:
1. Profile setup (name, age, height, weight, resting HR)
2. Zone setup (estimate or field test)
3. Training preferences (race date, days per week, long run day)
4. Race goal (with safety check)

**Every visit after:** you land straight on your dashboard — this week's plan, zones, predicted finish, and quick links to log workouts.

---

## HR Zone Method

Uses the **Karvonen (Heart Rate Reserve)** formula with the **Tanaka** max HR estimate for accuracy with older athletes:

- Max HR = 207 − (0.7 × age)
- HRR = Max HR − Resting HR
- Zone 1 (Recovery): 50–65% HRR
- Zone 2 (Base):     65–80% HRR
- Zone 3 (Speed):    80–92% HRR

Running the field test replaces the estimated max HR with your real measured peak.

---

## Pace Prediction

Uses **Riegel's formula**: `T2 = T1 × (D2/D1)^1.06`

Your most recent logged workout is used to predict your marathon finish time. As fitness improves, the prediction improves too.
