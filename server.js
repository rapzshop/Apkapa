// server.js
// APK Template Replacement builder (Option B)
// - Upload HTML (paste or file) or upload APK template (admin).
// - Replace a specified path inside the APK (e.g. assets/www/index.html).
// - Return generated APK for download.
// - Simple admin endpoints to upload template and view stats.

const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const sanitizeHtml = require('sanitize-html');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const CLEANUP_SECONDS = parseInt(process.env.CLEANUP_SECONDS || '3600', 10);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'db.json');
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ stats: { success: 0, fail: 0 }, requests: [] }, null, 2));
let DB = JSON.parse(fs.readFileSync(DB_FILE));

function saveDB(){ fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2)); }

// multer setup
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// templates directory (persist)
const TEMPLATES_DIR = path.join(__dirname, 'templates');
if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR);

// utility: basic HTML validation
function isLikelyHtml(s){
  if(!s || typeof s !== 'string') return false;
  const lowered = s.toLowerCase();
  if (lowered.includes('<!doctype html') || lowered.includes('<html') || lowered.includes('<body')) return true;
  return false;
}

// Admin: upload APK template (single file storage)
// header x-admin-pass must be provided
app.post('/api/admin/upload-template', upload.single('template'), (req, res) => {
  const pass = req.headers['x-admin-pass'] || req.query.pass || '';
  if(pass !== ADMIN_PASS) return res.status(401).json({ ok:false, message:'unauthorized' });
  if(!req.file) return res.status(400).json({ ok:false, message:'no file uploaded' });

  // Save template with timestamped name, but maintain a current-template link
  const name = `template_${Date.now()}.apk`;
  const filePath = path.join(TEMPLATES_DIR, name);
  fs.writeFileSync(filePath, req.file.buffer);

  // Also create/overwrite "current_template.apk" symlink-like copy for ease
  const cur = path.join(TEMPLATES_DIR, 'current_template.apk');
  fs.writeFileSync(cur, req.file.buffer);

  return res.json({ ok:true, message:'template uploaded', filename: name });
});

// Admin: list templates
app.get('/api/admin/templates', (req, res) => {
  const pass = req.headers['x-admin-pass'] || req.query.pass || '';
  if(pass !== ADMIN_PASS) return res.status(401).json({ ok:false, message:'unauthorized' });
  const files = fs.readdirSync(TEMPLATES_DIR).filter(f=>f.endsWith('.apk'));
  res.json({ ok:true, templates: files });
});

// Public: create APK from pasted HTML or uploaded html file
// body fields:
// - username (string)
// - projectName (string) optional
// - replacePath (string)  e.g. assets/www/index.html  <-- path INSIDE the APK to replace
// multipart form: file (optional) OR text (form field)
app.post('/api/create-apk', upload.single('file'), async (req, res) => {
  try {
    const username = (req.body.username || 'anon').toString().substring(0,64);
    const projectNameRaw = (req.body.projectName || 'rapz-app').toString();
    const projectName = projectNameRaw.replace(/[^\w\-]/g,'-').substring(0,50) || 'rapz-app';
    const replacePath = (req.body.replacePath || 'assets/www/index.html').toString();

    // input: either file (html) or text
    let htmlContent = null;
    if(req.file && req.file.buffer){
      // if user uploaded a zip or apk etc - if it's .html we prefer it
      const fname = (req.file.originalname || '').toLowerCase();
      if(fname.endsWith('.html') || fname.endsWith('.htm')){
        htmlContent = req.file.buffer.toString('utf8');
      } else {
        // if they uploaded other file types, reject for now
        return res.status(400).json({ ok:false, message:'Uploaded file not supported for direct replacement. Upload .html or use paste.' });
      }
    } else if (req.body.text){
      htmlContent = req.body.text.toString();
    } else {
      return res.status(400).json({ ok:false, message:'No HTML provided. Paste code or upload .html file.' });
    }

    // simple validation of HTML
    if(!isLikelyHtml(htmlContent)){
      return res.status(400).json({ ok:false, message:'Provided content does not look like valid HTML.' });
    }

    // sanitize (remove script tags that are obviously dangerous? — we still allow scripts)
    // but we won't strip scripts; only basic cleanup using sanitize-html if needed for safety display
    // For production you may want to enforce stricter policies.

    // find current template
    const curTemplate = path.join(TEMPLATES_DIR, 'current_template.apk');
    if(!fs.existsSync(curTemplate)){
      return res.status(500).json({ ok:false, message:'No APK template found on server. Upload via admin panel first.' });
    }

    // create output filename
    const outName = `${projectName}_${Date.now()}.apk`;
    const outPath = path.join(__dirname, 'generated');
    if(!fs.existsSync(outPath)) fs.mkdirSync(outPath);

    const outFull = path.join(outPath, outName);

    // read template as zip, replace entry at replacePath, write new zip (apk)
    const zip = new AdmZip(curTemplate);

    // check if entry exists (case-sensitive)
    const entry = zip.getEntry(replacePath);
    if(entry){
      zip.updateFile(replacePath, Buffer.from(htmlContent, 'utf8'));
    } else {
      // if not exist, create it at path
      // need to ensure directory entries exist (AdmZip will create internal entries automatically)
      zip.addFile(replacePath, Buffer.from(htmlContent, 'utf8'));
    }

    // write updated apk to generated folder
    zip.writeZip(outFull);

    // record DB
    const rec = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2,8),
      username, projectName, replacePath, filename: outName, createdAt: Date.now()
    };
    DB.requests.unshift(rec);
    DB.stats.success = (DB.stats.success || 0) + 1;
    saveDB();

    // schedule cleanup if desired
    setTimeout(()=> {
      try { fs.unlinkSync(outFull); } catch(e){/*ignore*/ }
    }, CLEANUP_SECONDS * 1000);

    // send download link
    return res.json({ ok:true, message:'APK generated', downloadUrl:`/generated/${outName}` });

  } catch (err) {
    console.error('create-apk error', err);
    DB.stats.fail = (DB.stats.fail || 0) + 1;
    DB.requests.unshift({ id: Date.now(), error: String(err) });
    saveDB();
    return res.status(500).json({ ok:false, message:'server error', error:String(err) });
  }
});

// serve generated files statically
const GEN_DIR = path.join(__dirname, 'generated');
if(!fs.existsSync(GEN_DIR)) fs.mkdirSync(GEN_DIR);
app.use('/generated', express.static(GEN_DIR));

// admin: view DB (stats & requests)
app.get('/api/admin/db', (req, res) => {
  const pass = req.query.pass || req.headers['x-admin-pass'] || '';
  if(pass !== ADMIN_PASS) return res.status(401).json({ ok:false, message:'unauthorized' });
  res.json({ ok:true, db: DB });
});

// Simple health
app.get('/api/health', (req,res)=> res.json({ ok:true }));

app.listen(PORT, ()=> console.log(`APK generator server listening on ${PORT}`));
  
