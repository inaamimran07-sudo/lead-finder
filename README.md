# 🎯 Lead Finder — Chatbot Prospect Tool

Find local businesses on Google Maps, score them as leads, generate outreach emails and track your pipeline.

---

## Setup & Deploy (Free on Render.com)

### Step 1 — Upload to GitHub
1. Go to github.com and create a free account if you don't have one
2. Click "New Repository" — call it "lead-finder"
3. Upload all these files into it

### Step 2 — Deploy on Render (free)
1. Go to render.com and sign up free
2. Click "New" → "Web Service"
3. Connect your GitHub account and select the lead-finder repo
4. Fill in these settings:
   - **Name**: lead-finder
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
5. Click "Add Environment Variable":
   - Key: `GOOGLE_API_KEY`
   - Value: your Google Places API key
6. Click "Create Web Service"
7. Wait 2-3 minutes — Render gives you a live URL like `https://lead-finder-xxxx.onrender.com`

That's it. Open the URL and it works from any device.

---

## Running Locally (optional)

```bash
npm install
# Edit .env and add your Google API key
node server.js
# Open http://localhost:3000
```

---

## Features
- 🔍 Search any industry + location via Google Maps
- 🔥 Auto-scores leads as Hot / Warm / Cold
- ✉️ Generates personalised outreach email per business
- 💾 Save leads to your pipeline
- 📊 Track status (New / Contacted / Interested / Closed)
- 📝 Add notes per lead
- ⬇ Export results to CSV

---

## Getting Your Google API Key
1. Go to console.cloud.google.com
2. Create a project
3. APIs & Services → Library → search "Places API" → Enable
4. APIs & Services → Credentials → Create API Key
5. Set up billing (free $200/month credit)
