require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.use(cors());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

function requireAuth(req, res, next) {
  const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Session expired' }); }
}

function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
  next();
}

async function requireAccess(req, res, next) {
  const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (!user.is_approved) return res.status(402).json({ error: 'awaiting_approval' });
  req.userRecord = user;
  next();
}

app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const { data: existing } = await supabase.from('users').select('id').eq('email', email).single();
  if (existing) return res.status(400).json({ error: 'An account with this email already exists' });
  const passwordHash = await bcrypt.hash(password, 10);
  const isAdmin = email.toLowerCase() === (process.env.ADMIN_EMAIL || '').toLowerCase();
  const { data: newUser, error } = await supabase.from('users').insert({
    email, name, password_hash: passwordHash,
    is_approved: isAdmin, is_admin: isAdmin,
    created_at: new Date().toISOString()
  }).select().single();
  if (error) return res.status(500).json({ error: 'Failed to create account' });
  const token = jwt.sign({ id: newUser.id, email: newUser.email, isAdmin }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 30*24*60*60*1000, sameSite: 'lax' });
  res.json({ success: true, user: { name: newUser.name, email: newUser.email, isAdmin, isApproved: isAdmin } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
  const token = jwt.sign({ id: user.id, email: user.email, isAdmin: user.is_admin }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 30*24*60*60*1000, sameSite: 'lax' });
  res.json({ success: true, user: { name: user.name, email: user.email, isAdmin: user.is_admin, isApproved: user.is_approved } });
});

app.post('/api/auth/logout', (req, res) => { res.clearCookie('token'); res.json({ success: true }); });

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
  if (!user) return res.status(401).json({ error: 'Not found' });
  res.json({ user: { name: user.name, email: user.email, isAdmin: user.is_admin, isApproved: user.is_approved } });
});

app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { data } = await supabase.from('users').select('id,name,email,is_approved,is_admin,created_at').order('created_at', { ascending: false });
  res.json(data || []);
});
app.post('/api/admin/approve/:id', requireAuth, requireAdmin, async (req, res) => {
  await supabase.from('users').update({ is_approved: true }).eq('id', req.params.id);
  res.json({ success: true });
});
app.post('/api/admin/revoke/:id', requireAuth, requireAdmin, async (req, res) => {
  await supabase.from('users').update({ is_approved: false }).eq('id', req.params.id);
  res.json({ success: true });
});
app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  await supabase.from('users').delete().eq('id', req.params.id);
  res.json({ success: true });
});

app.post('/api/user/apikey', requireAuth, async (req, res) => {
  const { googleApiKey } = req.body;
  if (!googleApiKey || !googleApiKey.startsWith('AIza')) return res.status(400).json({ error: 'Invalid key' });
  await supabase.from('users').update({ google_api_key: googleApiKey }).eq('id', req.user.id);
  res.json({ success: true });
});

const nearbyAreas = {
  manchester:['Manchester','Salford','Stockport','Oldham','Bolton','Bury'],
  london:['London','Croydon','Bromley','Ealing','Barnet','Hackney'],
  birmingham:['Birmingham','Wolverhampton','Solihull','Dudley','Walsall','Coventry'],
  leeds:['Leeds','Bradford','Wakefield','Huddersfield','Halifax','Harrogate'],
  liverpool:['Liverpool','Wirral','Warrington','St Helens','Birkenhead'],
  sheffield:['Sheffield','Rotherham','Doncaster','Barnsley','Chesterfield'],
  bristol:['Bristol','Bath','Weston-super-Mare','Gloucester','Cheltenham'],
};

function getAreas(location) {
  const key = location.toLowerCase();
  for (const [city, areas] of Object.entries(nearbyAreas)) {
    if (key.includes(city)) return areas;
  }
  return [location];
}

app.get('/api/search', requireAuth, requireAccess, async (req, res) => {
  const { industry, location } = req.query;
  if (!industry || !location) return res.status(400).json({ error: 'Required' });
  const { data: user } = await supabase.from('users').select('google_api_key').eq('id', req.user.id).single();
  if (!user?.google_api_key) return res.status(400).json({ error: 'no_api_key' });
  const apiKey = user.google_api_key;
  try {
    const areas = getAreas(location);
    const allPlaces = [], seenIds = new Set();
    await Promise.all(areas.map(async (area) => {
      try {
        const r = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', { params: { query: `${industry} in ${area}`, key: apiKey } });
        if (r.data.status === 'REQUEST_DENIED') throw new Error('API key rejected');
        for (const p of (r.data.results||[])) { if (!seenIds.has(p.place_id)) { seenIds.add(p.place_id); allPlaces.push(p); } }
        if (r.data.next_page_token) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          const r2 = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', { params: { pagetoken: r.data.next_page_token, key: apiKey } });
          for (const p of (r2.data.results||[])) { if (!seenIds.has(p.place_id)) { seenIds.add(p.place_id); allPlaces.push(p); } }
        }
      } catch (e) { console.log(area + ' failed: ' + e.message); }
    }));
    if (!allPlaces.length) return res.json({ results: [] });
    const detailed = await Promise.all(allPlaces.slice(0,60).map(p => fetchDetails(p, industry, apiKey)));
    detailed.sort((a,b) => {
      const o={hot:0,warm:1,cold:2};
      if (o[a.leadScore]!==o[b.leadScore]) return o[a.leadScore]-o[b.leadScore];
      if (!a.hasWebsite&&b.hasWebsite) return -1;
      if (a.hasWebsite&&!b.hasWebsite) return 1;
      return (b.reviews||0)-(a.reviews||0);
    });
    res.json({ results: detailed, areasSearched: areas });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function fetchDetails(place, industry, apiKey) {
  try {
    const r = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', { params: { place_id: place.place_id, fields: 'name,formatted_address,rating,user_ratings_total,website,formatted_phone_number,url', key: apiKey } });
    const d = r.data.result||{};
    return scorePlace({ ...place, website: d.website||place.website, formatted_phone_number: d.formatted_phone_number, googleMapsUrl: d.url }, industry);
  } catch(e) { return scorePlace(place, industry); }
}

function scorePlace(place, industry) {
  const hasWebsite=!!place.website, rating=place.rating||0, reviews=place.user_ratings_total||0;
  let score=0, signals=[];
  if (!hasWebsite){score+=3;signals.push({text:'No website',type:'bad'});}else{score+=1;signals.push({text:'Has website',type:'good'});}
  if (rating>=4){score+=2;signals.push({text:'stars: '+rating,type:'good'});}else if(rating>0)signals.push({text:'stars: '+rating,type:'neutral'});
  if (reviews>=20){score+=1;signals.push({text:reviews+' reviews',type:'good'});}else if(reviews>0)signals.push({text:reviews+' reviews',type:'neutral'});
  signals.push({text:'No chatbot detected',type:'bad'});score+=2;
  return {
    name:place.name, address:place.formatted_address||place.vicinity||'',
    phone:place.formatted_phone_number||null, rating, reviews, hasWebsite,
    website:place.website||null, placeId:place.place_id,
    googleMapsUrl:place.googleMapsUrl||('https://www.google.com/maps/place/?q=place_id:'+place.place_id),
    socialLinks:{
      facebookSearch:'https://www.facebook.com/search/pages/?q='+encodeURIComponent(place.name),
      instagramSearch:'https://www.google.com/search?q='+encodeURIComponent(place.name+' instagram')
    },
    signals, leadScore:score>=7?'hot':score>=5?'warm':'cold', industry
  };
}

app.get('/api/leads', requireAuth, async (req,res) => {
  const {data} = await supabase.from('leads').select('*').eq('user_id',req.user.id).order('saved_at',{ascending:false});
  res.json(data||[]);
});
app.post('/api/leads', requireAuth, async (req,res) => {
  const lead={...req.body,user_id:req.user.id,saved_at:new Date().toISOString(),status:'new'};
  delete lead.id;
  const {data,error}=await supabase.from('leads').insert(lead).select().single();
  if(error)return res.status(500).json({error:error.message});
  res.json(data);
});
app.patch('/api/leads/:id', requireAuth, async (req,res) => {
  const {data,error}=await supabase.from('leads').update(req.body).eq('id',req.params.id).eq('user_id',req.user.id).select().single();
  if(error)return res.status(500).json({error:error.message});
  res.json(data);
});
app.delete('/api/leads/:id', requireAuth, async (req,res) => {
  await supabase.from('leads').delete().eq('id',req.params.id).eq('user_id',req.user.id);
  res.json({success:true});
});

app.get('*', (req,res) => res.sendFile(require('path').join(__dirname,'public','index.html')));
app.listen(PORT, () => console.log('LeadForge running on port ' + PORT));
