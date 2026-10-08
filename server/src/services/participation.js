// Participation scoring — ranks members on observable engagement signals.
// Consumed by the President-only /users/participation endpoint.
//
// Score is a transparent weighted sum of three normalized components:
//
//   attendanceComponent:  attendance rate (Present + Excused) / total recorded attendance
//   pitchComponent:       pitches presented, capped at PITCH_CAP (pitches beyond this don't
//                         keep adding score — diminishing returns after you've demonstrated
//                         you can pitch)
//   roleComponent:        operational role rank / 10 (President 10 → 1.0, JuniorAnalyst 4 → 0.4)
//
// The weights (below) sum to 100 so scores sit on a 0-100 scale that's easy
// for the President to read. Advisory-tier roles (rank = 1) are excluded
// from the ranking — they're observers, not active members.
import { ROLE_RANK } from '../middleware/auth.js';
import { isActive } from './memberStatus.js';

const WEIGHT_ATTENDANCE = 50;
const WEIGHT_PITCHES = 35;
const WEIGHT_ROLE = 15;
const PITCH_CAP = 5; // pitches beyond this don't add more to the score
// Excludes Advisory/Faculty (rank 1) and the non-investment officers at
// rank 2 (Chief of Communication, Director of Public Relations). The
// first are observers. The second sit outside the analyst chain and
// don't pitch, so a score built from attendance plus pitches would
// misread the office. Rank is the switch: a new officer who should be
// ranked needs a rank above this line, not a name added here.
const EXCLUDE_RANK_AT_OR_BELOW = 2;

function roundTo(n, digits = 1) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export async function computeParticipation(prisma) {
  // Pull every active user along with the minimum data we need to aggregate.
  // Including zero-pitch / zero-attendance members keeps the ranking honest —
  // low engagement shouldn't be hidden by omission.
  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      memberStatus: true,
      createdAt: true,
    },
    orderBy: { name: 'asc' },
  });

  // Aggregate attendance rows per user. Only Present counts toward the
  // score; Absent and Excused both pull it down, but Excused is half-
  // weighted — two excuses equal one missed meeting. The intent is to
  // reward people who show up, while still acknowledging that a
  // documented conflict isn't the same as a no-show.
  // Rate = Present / (Present + Absent + 0.5 × Excused).
  // Marks at a cancelled meeting stay in the table (a restore brings
  // them back) but count for nobody.
  const attendanceRows = await prisma.attendance.groupBy({
    by: ['userId', 'status'],
    where: { event: { cancelledAt: null } },
    _count: { _all: true },
  });
  const attByUser = new Map();
  for (const row of attendanceRows) {
    const bucket = attByUser.get(row.userId) || {
      present: 0,
      excused: 0,
      absent: 0,
      total: 0,
    };
    const n = row._count._all;
    bucket.total += n;
    if (row.status === 'Present') bucket.present += n;
    else if (row.status === 'Excused') bucket.excused += n;
    else if (row.status === 'Absent') bucket.absent += n;
    attByUser.set(row.userId, bucket);
  }

  // Pitches — use PitchPresenter, the modern link (Pitch.pitcherName is a
  // legacy display string that doesn't always match a User row).
  const pitchRows = await prisma.pitchPresenter.groupBy({
    by: ['userId'],
    _count: { _all: true },
  });
  const pitchByUser = new Map(pitchRows.map((r) => [r.userId, r._count._all]));

  const rows = [];
  for (const u of users) {
    const rank = ROLE_RANK[u.role] ?? 0;
    if (rank <= EXCLUDE_RANK_AT_OR_BELOW) continue;
    // Off the weekly roster by standing (alumni, on leave …): half the
    // score is attendance, and it would be marking them down for meetings
    // nobody expects them at.
    if (!isActive(u.memberStatus)) continue;

    const att = attByUser.get(u.id) || { present: 0, excused: 0, absent: 0, total: 0 };
    const counted = att.present + att.absent + 0.5 * att.excused;
    const attendanceRate = counted > 0 ? att.present / counted : 0;

    const pitchCount = pitchByUser.get(u.id) || 0;
    const pitchFraction = Math.min(pitchCount / PITCH_CAP, 1);

    const roleFraction = rank / 10;

    const score =
      WEIGHT_ATTENDANCE * attendanceRate +
      WEIGHT_PITCHES * pitchFraction +
      WEIGHT_ROLE * roleFraction;

    rows.push({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      roleRank: rank,
      createdAt: u.createdAt,
      attendance: {
        present: att.present,
        excused: att.excused,
        absent: att.absent,
        total: att.total,
        ratePct: roundTo(attendanceRate * 100, 1),
      },
      pitches: pitchCount,
      components: {
        attendance: roundTo(WEIGHT_ATTENDANCE * attendanceRate, 1),
        pitches: roundTo(WEIGHT_PITCHES * pitchFraction, 1),
        role: roundTo(WEIGHT_ROLE * roleFraction, 1),
      },
      score: roundTo(score, 1),
    });
  }

  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return {
    weights: {
      attendance: WEIGHT_ATTENDANCE,
      pitches: WEIGHT_PITCHES,
      role: WEIGHT_ROLE,
      pitchCap: PITCH_CAP,
    },
    computedAt: new Date().toISOString(),
    rows,
  };
}
