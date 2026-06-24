import multer from 'multer';
import path from 'node:path';

const ALLOWED_EXT = new Set(['.pdf', '.pptx', '.ppt']);

function fileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_EXT.has(ext)) return cb(null, true);
  cb(new Error('Only .pdf, .ppt, and .pptx files are allowed'));
}

// Content sniff. The extension and the client-sent MIME are both
// attacker-controlled, so confirm the actual leading bytes match the declared
// kind before we store/serve the file — arbitrary bytes named ".pdf" otherwise
// pass. Run in the route handler (memoryStorage gives us the buffer there).
export function bufferMatchesDeclared(buffer, originalname) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  const ext = path.extname(originalname || '').toLowerCase();
  const starts = (sig) => sig.every((byte, i) => buffer[i] === byte);
  const isPdf = starts([0x25, 0x50, 0x44, 0x46]); // "%PDF"
  const isZip =
    starts([0x50, 0x4b, 0x03, 0x04]) ||
    starts([0x50, 0x4b, 0x05, 0x06]) ||
    starts([0x50, 0x4b, 0x07, 0x08]); // OOXML (.pptx) is a zip
  const isOle = starts([0xd0, 0xcf, 0x11, 0xe0]); // legacy OLE (.ppt)
  if (ext === '.pdf') return isPdf;
  if (ext === '.pptx') return isZip;
  if (ext === '.ppt') return isOle || isZip;
  return false;
}

// In-memory storage so we can stream the buffer into whichever backend
// storage.js is configured for (R2 in prod, disk in dev).
export const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});
