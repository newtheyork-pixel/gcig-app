// One definition of how a member signs a letter to a stranger.
//
// There were two. The route that sends immediately built the block with
// the sender's title in it; the cron that sends a scheduled draft built
// its own, four lines long and missing the title line entirely. Nobody
// noticed because the terminal only ever renders the route's version, so
// the preview showed a title and the letter that actually left did not.
// Most of the Signet campaign went out that way.
//
// Anything that resolves {{SIGNATURE}} imports from here. A second copy
// of these four lines somewhere else is the bug, not the risk of it.

export const SIGNATURE_TOKEN = '{{SIGNATURE}}';

// Titles as a recipient should read them. Role names are internal
// vocabulary and JuniorAnalyst under a school crest reads like a
// hierarchy nobody outside the club needs explained.
//
// Both spellings of the advisor role are present deliberately: the Prisma
// enum says FacultyAdvisory and half the codebase says FacultyAdvisor, and
// until that is reconciled a missing key here signs the school's
// supervising adult as a student "Analyst" on a cold email.
export const OUTREACH_TITLE = {
  President: 'President',
  CIO: 'Chief Investment Officer',
  SeniorPortfolioManager: 'Portfolio Manager',
  PortfolioManager: 'Portfolio Manager',
  SeniorAnalyst: 'Analyst',
  Analyst: 'Analyst',
  JuniorAnalyst: 'Analyst',
  FacultyAdvisor: 'Faculty Advisor',
  FacultyAdvisory: 'Faculty Advisor',
  AdvisoryBoardMember: 'Advisory Board',
  ChiefOfCommunication: 'Communications',
};

export function signatureFor(user) {
  if (!user) return SIGNATURE_TOKEN;
  const title = OUTREACH_TITLE[user.role] || 'Analyst';
  return [user.name, `${title}, The Griffin Fund`, 'Grace Church School', user.email]
    .filter(Boolean)
    .join('\n');
}

export function renderSignature(body, user) {
  if (typeof body !== 'string' || !body.includes(SIGNATURE_TOKEN)) return body;
  return body.split(SIGNATURE_TOKEN).join(signatureFor(user));
}
