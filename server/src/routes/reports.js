import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, requireRole } from '../middleware/auth.js';

const canEditReports = requireRole('PortfolioManager');

const router = Router();
router.use(verifyJwt);

router.get('/', async (_req, res) => {
  const reports = await prisma.report.findMany({ orderBy: { date: 'desc' } });
  res.json(reports);
});

router.post('/', canEditReports, async (req, res) => {
  const { title, author, ticker, date, description, fileUrl } = req.body || {};
  if (!title || !author || !date || !fileUrl) {
    return res.status(400).json({ error: 'title, author, date, and link required' });
  }
  const report = await prisma.report.create({
    data: {
      title,
      author,
      ticker: ticker ? ticker.toUpperCase() : null,
      date: new Date(date),
      description: description || null,
      fileUrl,
    },
  });
  res.status(201).json(report);
});

router.put('/:id', canEditReports, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.report.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { title, author, ticker, date, description, fileUrl } = req.body || {};
  const data = {};
  if (title !== undefined) data.title = title;
  if (author !== undefined) data.author = author;
  if (ticker !== undefined) data.ticker = ticker ? ticker.toUpperCase() : null;
  if (date !== undefined) data.date = new Date(date);
  if (description !== undefined) data.description = description || null;
  if (fileUrl !== undefined) data.fileUrl = fileUrl;

  const report = await prisma.report.update({ where: { id }, data });
  res.json(report);
});

router.delete('/:id', canEditReports, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.report.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  await prisma.report.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
