import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// Known historical lots. Seeded once per ticker; if a matching row is already
// present (same ticker + shares + pricePerShare + buyDate), we leave it alone.
const INITIAL_LOTS = [
  // MLAB — Mesa Laboratories
  {
    ticker: 'MLAB',
    shares: 68,
    pricePerShare: 72.94,
    buyDate: new Date('2025-10-17T00:00:00Z'),
  },
  {
    ticker: 'MLAB',
    shares: 53,
    pricePerShare: 100.44,
    buyDate: new Date('2026-04-14T00:00:00Z'),
  },
];

async function seedLots() {
  for (const lot of INITIAL_LOTS) {
    const existing = await prisma.holdingLot.findFirst({
      where: {
        ticker: lot.ticker,
        shares: lot.shares,
        pricePerShare: lot.pricePerShare,
        buyDate: lot.buyDate,
      },
    });
    if (existing) continue;
    await prisma.holdingLot.create({ data: lot });
    console.log(
      `Seeded lot: ${lot.ticker} ${lot.shares} sh @ $${lot.pricePerShare} on ${lot.buyDate.toISOString().slice(0, 10)}`
    );
  }
}

async function main() {
  const email = 'wseirer@gcschool.org';
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    const passwordHash = await bcrypt.hash('ChangeMe123!', 10);
    const user = await prisma.user.create({
      data: {
        name: 'Thomas Seirer',
        email,
        passwordHash,
        role: 'President',
      },
    });
    console.log(`Seeded President account:`);
    console.log(`  email:    ${user.email}`);
    console.log(`  password: ChangeMe123!`);
    console.log(`  role:     ${user.role}`);
    console.log(`\nRotate the password after first login.`);
  } else {
    console.log(`President account already exists: ${email}`);
  }

  await seedLots();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
