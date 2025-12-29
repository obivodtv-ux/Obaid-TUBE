# 🎬 Obaid Tube — FFmpeg Worker Deployment (All-in-one)

## 1️⃣ Inside GitHub repo create folder:
## 2️⃣ Add these 3 files exactly as below:

---

### 📁 worker/package.json
```json
{
  "name": "obaid-tube-worker",
  "version": "1.0.0",
  "main": "server.js",
  "type": "module",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.600.0",
    "@supabase/supabase-js": "^2.45.0",
    "express": "^4.19.2"
  }
}
FROM node:20-bookworm
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
import express from "express";
import { runJob } from "./transcode.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_, res) => res.json({ ok: true, service: "Obaid Tube Worker" }));

app.post("/jobs/transcode", async (req, res) => {
  try {
    const { videoId, sourceKey } = req.body || {};
    if (!videoId || !sourceKey) {
      return res.status(400).json({ error: "videoId and sourceKey are required" });
    }

    const result = await runJob({ videoId, sourceKey });
    return res.json({ ok: true, result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "Worker failed" });
  }
});

app.listen(process.env.PORT || 8080, () => {
  console.log("Worker running on port", process.env.PORT || 8080);
});
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";

const TMP = "/tmp";

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Supabase client (service role)
const supabase = createClient(
  must("SUPABASE_URL"),
  must("SUPABASE_SERVICE_ROLE_KEY")
);

// Cloudflare R2 client (S3 compatible)
const r2 = new S3Client({
  region: "auto",
  endpoint: must("R2_ENDPOINT"),
  credentials: {
    accessKeyId: must("R2_ACCESS_KEY"),
    secretAccessKey: must("R2_SECRET_KEY"),
  },
});

const BUCKET = must("R2_BUCKET");
const PUBLIC_VIDEO_BASE_URL = must("PUBLIC_VIDEO_BASE_URL");

// Save stream to local file
async function streamToFile(readable, filePath) {
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(filePath);
    readable.pipe(w);
    readable.on("error", reject);
    w.on("finish", resolve);
    w.on("error", reject);
  });
}

// Download original video from R2
async function downloadFromR2(key, destPath) {
  const obj = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  await streamToFile(obj.Body, destPath);
}

// Upload a file to R2
async function uploadFileToR2(localPath, key, contentType) {
  const body = fs.createReadStream(localPath);
  await r2.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

// Run FFmpeg to create HLS + thumbnail
function transcodeToHLS(inputPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  // Create thumbnail at 3 seconds
  const thumbPath = path.join(outDir, "thumb.jpg");
  execSync(`ffmpeg -y -ss 00:00:03 -i "${inputPath}" -frames:v 1 -q:v 2 "${thumbPath}"`, { stdio: "inherit" });

  // Create 720p HLS (MVP quality)
  const hlsMaster = path.join(outDir, "master.m3u8");
  execSync(
    `ffmpeg -y -i "${inputPath}" -vf scale=-2:720 -c:v h264 -preset veryfast -profile:v baseline -level 3.0 -c:a aac -b:a 128k -hls_time 6 -hls_list_size 0 -hls_flags independent_segments -f hls "${hlsMaster}"`,
    { stdio: "inherit" }
  );

  return { thumbPath, hlsMaster };
}

// Upload generated outputs folder to R2
async function uploadFolderToR2(localDir, videoId) {
  const files = fs.readdirSync(localDir);
  const prefix = `videos/${videoId}`;

  for (const f of files) {
    const p = path.join(localDir, f);
    if (fs.lstatSync(p).isDirectory()) continue;

    const ext = path.extname(f).toLowerCase();
    const ct =
      ext === ".m3u8" ? "application/vnd.apple.mpegurl" :
      ext === ".ts" ? "video/mp2t" :
      ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
      "application/octet-stream";

    await uploadFileToR2(p, `${prefix}/${f}`, ct);
  }

  return { hlsMasterUrl: `${PUBLIC_VIDEO_BASE_URL}/videos/${videoId}/master.m3u8`, thumbUrl: `${PUBLIC_VIDEO_BASE_URL}/videos/${videoId}/thumb.jpg` };
}

// Main job
export async function runJob({ videoId, sourceKey }) {
  const workDir = path.join(TMP, `obaid-${videoId}-${Date.now()}`);
  const inputPath = path.join(workDir, "input.mp4");
  const outDir = path.join(workDir, "out");

  fs.mkdirSync(workDir, { recursive: true });

  await supabase.from("videos").update({ status: "PROCESSING" }).eq("id", videoId);

  try {
    await downloadFromR2(sourceKey, inputPath);
    const dur = Math.round(Number(execSync(`ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${inputPath}"`).toString().trim()));

    const { thumbPath, hlsMaster } = await transcodeToHLS(inputPath, outDir);
    const assets = await uploadFolderToR2(outDir, videoId);

    const { error } = await supabase.from("videos").update({
      status: "PUBLISHED",
      duration_seconds: dur,
      hls_master_url: assets.hlsMasterUrl,
      thumb_url: assets.thumbUrl,
    }).eq("id", videoId);

    if (error) throw new Error(error.message);

    return { videoId, ...assets, duration: dur };
  } catch (e) {
    await supabase.from("videos").update({ status: "FAILED" }).eq("id", videoId);
    throw e;
  }
}
