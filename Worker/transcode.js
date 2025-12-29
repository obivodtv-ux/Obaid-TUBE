import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";

const TMP = "/tmp";

function must(n) {
  const v = process.env[n];
  if (!v) throw new Error(`Missing ${n}`);
  return v;
}

const supabase = createClient(must("SUPABASE_URL"), must("SUPABASE_SERVICE_ROLE_KEY"));

const r2 = new S3Client({
  region: "auto",
  endpoint: must("R2_ENDPOINT"),
  credentials: { accessKeyId: must("R2_ACCESS_KEY"), secretAccessKey: must("R2_SECRET_KEY") }
});

async function streamToFile(stream, file) {
  const w = fs.createWriteStream(file);
  stream.pipe(w);
  await new Promise(r => w.on("finish", r));
}

async function download(key, file) {
  const obj = await r2.send(new GetObjectCommand({ Bucket: must("R2_BUCKET"), Key: key }));
  await streamToFile(obj.Body, file);
}

function hls(inFile, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  execSync(`ffmpeg -y -i "${inFile}" -vf scale=-2:720 -c:v h264 -preset veryfast -profile:v baseline -level 3.0 -c:a aac -b:a 128k -hls_time 6 -hls_list_size 0 -hls_flags independent_segments -f hls "${outDir}/master.m3u8"`);
  execSync(`ffmpeg -y -ss 00:00:03 -i "${inFile}" -frames:v 1 "${outDir}/thumb.jpg"`);
}

export async function runJob({ videoId, sourceKey }) {
  const work = path.join(TMP, videoId);
  const inFile = path.join(work, "input.mp4");
  const out = path.join(work, "out");

  await download(sourceKey, inFile);
  await hls(inFile, out);

  await supabase.from("videos").update({
    status: "PUBLISHED",
    hls_master_url: `${must("PUBLIC_VIDEO_BASE_URL")}/videos/${videoId}/master.m3u8`,
    thumb_url: `${must("PUBLIC_VIDEO_BASE_URL")}/videos/${videoId}/thumb.jpg`
  }).eq("id", videoId);

  return { ok: true, videoId };
}
