# MailGuard Pro v7 — Complete Setup Guide

---

## What is this?

A Chrome extension that scans your Gmail inbox for phishing emails,
malicious URLs, and prompt injection attacks using your own local ML models.
Everything runs on your machine — no cloud, no Vercel, no third-party API
(except optional OpenAI for AI summaries).

---

## Before You Start — Requirements

- Windows 10/11
- Python 3.9 or higher  →  https://python.org/downloads
- Google Chrome browser
- Your 10 model .pkl files (from models.zip)

---

## STEP 1 — Copy Your Model Files

Extract your models.zip and copy ALL .pkl files into the models/ folder:

    mailguard_complete/
    └── server/
        └── models/          ← PASTE ALL 10 FILES HERE
            ├── email_vectorizer.pkl
            ├── email_classifier.pkl
            ├── email_scaler.pkl
            ├── url_classifier.pkl
            ├── url_label_encoder.pkl
            ├── url_feature_names.pkl
            ├── injection_classifier.pkl
            ├── injection_vectorizer.pkl
            ├── injection_scaler.pkl
            └── injection_struct_features.pkl

If any file is missing the server will return a 500 error.

---

## STEP 2 — Start the Local Server

Double-click:  server/start.bat

This will:
  1. Install all Python dependencies (first time only, takes ~2 min)
  2. Start the Flask API on http://localhost:5000

You will see this when it's ready:
  -------------------------------------------------------
    MailGuard Pro v7 — Local API Server
    http://localhost:5000/api/analyze
  -------------------------------------------------------

KEEP THIS WINDOW OPEN while using the extension.
The server must be running before you click Start Detection.

To verify it's working, open your browser and go to:
  http://localhost:5000/api/health

You should see:  {"status": "ok"}

---

## STEP 3 — Load the Extension in Chrome

1. Open Chrome and go to:   chrome://extensions
2. Turn ON "Developer mode" (toggle in the top-right corner)
3. Click "Load unpacked"
4. Navigate to and select the   extension/   folder
5. MailGuard Pro should appear in your extensions list

Pin it to your toolbar:
  Click the puzzle icon (🧩) next to the address bar → pin MailGuard Pro

---

## STEP 4 — Sign In and Start Detection

1. Click the MailGuard Pro icon in your toolbar
2. You should see  SERVER ONLINE :5000  (green dot)
   → If it says OFFLINE, go back to Step 2
3. Click  START DETECTION
4. Chrome will ask you to sign in with Google — allow it
5. The ring turns cyan and says  DETECTION: ACTIVE

The extension will now scan your inbox every 30 seconds automatically.

---

## STEP 5 — Open the Dashboard

Click  [ OPEN THREAT DASHBOARD → ]  in the popup

The dashboard has 5 tabs:

  ANALYSIS     →  Full ML evidence, header checks, link scores for each email
  PASTE SCAN   →  Paste any email text and scan it without Gmail connection
  OVERVIEW     →  Threat stats, top risky senders, X-Mailer detections
  BLOCKED      →  Auto-blocked senders (triggered after 3+ critical emails)
  SETTINGS     →  Theme toggle, OpenAI API key

---

## STEP 6 (Optional) — Enable AI Analysis with OpenAI

For GPT-4o-mini security summaries per email:

1. Get an API key from https://platform.openai.com/api-keys
2. Dashboard → SETTINGS tab
3. Paste your  sk-...  key into the API KEY field
4. Click  SAVE CONFIG
5. On any email's ANALYSIS tab, click  REQUEST AI ANALYSIS

---

## How Risk Scores Work

Scores come 100% from your ML models — no blending or override.

  80–100  →  CRITICAL  (model confident it's phishing/malware)
  60–79   →  HIGH
  35–59   →  MEDIUM
  0–34    →  SAFE

Auto-block triggers when the same sender gets 3 or more CRITICAL emails.

---

## Troubleshooting

PROBLEM: "SERVER OFFLINE" in popup
FIX:     Make sure start.bat is running and the CMD window is still open.
         Check http://localhost:5000/api/health in your browser.

PROBLEM: "Could not establish connection" error in browser console
FIX:     Go to chrome://extensions → click the refresh icon on MailGuard Pro.
         This is a Chrome MV3 service worker timeout — normal after inactivity.

PROBLEM: Risk score looks wrong / too low
FIX:     Check your .pkl files are all in server/models/ and not in subfolders.
         Run the test command below to verify models load correctly.

PROBLEM: "idf vector is not fitted" error
FIX:     Your email_vectorizer.pkl was saved before .fit() was called.
         The model needs to be retrained and re-exported correctly.

PROBLEM: Score is 90 in direct test but low in extension
FIX:     Already fixed in v7 — scores come directly from model confidence.
         Reload the extension after updating files.

PROBLEM: Gmail not scanning / no emails appearing
FIX:     Click STOP then START DETECTION again to re-authenticate.
         Make sure you allowed Google sign-in when prompted.

---

## Quick Model Test (CMD)

To verify your models are loaded and working:

    cd server
    python -c "
    import joblib, os
    models = ['email_vectorizer','email_classifier','email_scaler',
              'url_classifier','url_label_encoder','url_feature_names',
              'injection_classifier','injection_vectorizer','injection_scaler']
    for m in models:
        path = f'models/{m}.pkl'
        try:
            obj = joblib.load(path)
            print(f'OK  {m}  ({type(obj).__name__})')
        except Exception as e:
            print(f'ERR {m}  {e}')
    "

All lines should show OK. Any ERR means that file is missing or corrupted.

To test a live scan via curl:

    curl -X POST http://localhost:5000/api/analyze ^
      -H "Content-Type: application/json" ^
      -d "{\"type\":\"email\",\"content\":\"Urgent: Click here to verify your PayPal account\",\"sender\":\"support@paypa1.xyz\"}"

Expected response: prediction=phishing, confidence > 70

---

## Project Structure

    mailguard_complete/
    │
    ├── server/                   ← Python Flask API (run this)
    │   ├── server.py             ← Main server entry point
    │   ├── analyze_email.py      ← Email phishing detection
    │   ├── analyze_url.py        ← Malicious URL classification
    │   ├── analyze_injection.py  ← Prompt injection detection
    │   ├── requirements.txt      ← Python dependencies
    │   ├── start.bat             ← Windows: double-click to start
    │   └── models/               ← Your .pkl files go here
    │
    └── extension/                ← Chrome extension (load unpacked)
        ├── manifest.json
        ├── background.js         ← Service worker, Gmail polling
        ├── popup.html/js         ← Toolbar popup
        ├── dashboard.html/js     ← Full threat dashboard
        ├── content.js/css        ← Gmail page integration
        └── icons/

---

## Every Time You Use It

  1. Double-click  server/start.bat   (keep window open)
  2. Click MailGuard Pro in Chrome toolbar
  3. Check green dot = SERVER ONLINE
  4. Click START DETECTION

That's it. The extension scans automatically from that point.

