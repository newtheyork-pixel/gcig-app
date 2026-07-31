import test from 'node:test';
import assert from 'node:assert/strict';
import {
  displayName, officeOf, buildRoster, parseOwnershipDoc, extractItem502, decodeEntities, sameHuman, mergeLeadership, mergeBoard,
} from './officerRoster.js';

test('surname-first filings read like names again', () => {
  assert.equal(displayName('Owens Gary M'), 'Gary M Owens');
  assert.equal(displayName('Crennen Lyndsey Elizabeth'), 'Lyndsey Elizabeth Crennen');
  assert.equal(displayName('Kadia Siddhartha'), 'Siddhartha Kadia');
  assert.equal(displayName('Sakys John'), 'John Sakys');
});

test('a suffix is not a forename and a particle belongs to the surname', () => {
  assert.equal(displayName('Smith John Jr'), 'John Smith Jr');
  assert.equal(displayName('Van Dort Oran'), 'Oran Van Dort');
  assert.equal(displayName('Robinson, Charles H'), 'Charles H Robinson');
  assert.equal(displayName('Cher'), 'Cher');
});

test('a shouted name is cased, a deliberately cased one is left alone', () => {
  assert.equal(displayName('PETRELLA VINCENT K'), 'Vincent K Petrella');
  assert.equal(displayName('McDonald Alan'), 'Alan McDonald');
  assert.equal(displayName('HOFFNER WARREN E III'), 'Warren E Hoffner III');
});

test('entities are decoded, in names and in titles', () => {
  assert.equal(decodeEntities('Vice President-CFO &amp; Treasurer'), 'Vice President-CFO & Treasurer');
  assert.equal(decodeEntities('&#160;On June&#8217;s'), ' On June’s');
  const xml = `<ownershipDocument><reportingOwner>
    <reportingOwnerId><rptOwnerName>Wells David K.</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isOfficer>1</isOfficer>
    <officerTitle>Vice President-CFO &amp; Treasurer</officerTitle>
    </reportingOwnerRelationship></reportingOwner></ownershipDocument>`;
  assert.equal(parseOwnershipDoc(xml, { form: '4', filedAt: '2025-08-14' }).title,
    'Vice President-CFO & Treasurer');
});

test('titles map to the office they name, chief executive first', () => {
  assert.equal(officeOf('President and CEO'), 'ceo');
  assert.equal(officeOf('Chief Executive Officer'), 'ceo');
  assert.equal(officeOf('CFO'), 'cfo');
  assert.equal(officeOf('CAO'), 'cao');
  assert.equal(officeOf('Chief Accounting Officer'), 'cao');
  assert.equal(officeOf('SVP Operations'), null);
  assert.equal(officeOf(''), null);
});

test('the newest holder of an office displaces the previous one', () => {
  // The real Mesa Labs sequence: Owens files in April, Kadia files a
  // Form 3 three weeks later carrying the same title.
  const roster = buildRoster([
    { filedName: 'Owens Gary M', title: 'President and CEO', isOfficer: true, form: '4', filedAt: '2026-04-02' },
    { filedName: 'Kadia Siddhartha', title: 'President and CEO', isOfficer: true, form: '3', filedAt: '2026-04-24' },
    { filedName: 'Sakys John', title: 'CFO', isOfficer: true, form: '4', filedAt: '2026-06-23' },
  ]);
  const ceo = roster.find((p) => p.office === 'ceo' && !p.former);
  assert.equal(ceo.name, 'Siddhartha Kadia');
  const old = roster.find((p) => p.former);
  assert.equal(old.name, 'Gary M Owens');
  assert.equal(old.supersededBy, 'Siddhartha Kadia');
  assert.equal(old.supersededBy_at, '2026-04-24');
  // Current officers sort above departed ones.
  assert.ok(roster.indexOf(ceo) < roster.indexOf(old));
});

test('the newest filing wins a promotion', () => {
  const roster = buildRoster([
    { filedName: 'Crennen Lyndsey', title: 'Controller', isOfficer: true, form: '4', filedAt: '2026-01-10' },
    { filedName: 'Crennen Lyndsey', title: 'Chief Accounting Officer', isOfficer: true, form: '3', filedAt: '2026-06-16' },
  ]);
  assert.equal(roster.length, 1);
  assert.equal(roster[0].title, 'Chief Accounting Officer');
  assert.equal(roster[0].form3At, '2026-06-16');
});

test('ownership XML yields a name, a title and the flags', () => {
  const xml = `<?xml version="1.0"?><ownershipDocument>
    <reportingOwner><reportingOwnerId><rptOwnerName>Kadia Siddhartha</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer>
    <officerTitle>President and CEO</officerTitle></reportingOwnerRelationship></reportingOwner>
    </ownershipDocument>`;
  const d = parseOwnershipDoc(xml, { form: '3', filedAt: '2026-04-24' });
  assert.equal(d.filedName, 'Kadia Siddhartha');
  assert.equal(d.title, 'President and CEO');
  assert.equal(d.isOfficer, true);
  assert.equal(d.isDirector, true);
  assert.equal(parseOwnershipDoc('<html>not a form</html>'), null);
});

test('item 5.02 comes back as prose without its boilerplate heading', () => {
  const html = `<html><body><p>Item 5.02 Departure of Directors or Certain Officers; Election of
    Directors; Appointment of Certain Officers.</p><p>On March 3, 2026, Mesa Laboratories, Inc.
    initiated a leadership transition pursuant to which Gary Owens will depart as President and
    Chief Executive&nbsp;Officer.</p><p>SIGNATURES</p><p>Pursuant to the requirements</p></body></html>`;
  const s = extractItem502(html);
  assert.match(s, /^On March 3, 2026/);
  assert.match(s, /Chief Executive Officer/);
  assert.doesNotMatch(s, /SIGNATURES/);
  assert.equal(extractItem502('<html><body>nothing here</body></html>'), '');
});

test('two filers writing the same person are recognised as one', () => {
  assert.ok(sameHuman('Gary Owens', 'Gary M Owens'));
  assert.ok(sameHuman('John V. Sakys', 'John Sakys'));
  assert.ok(!sameHuman('Gary Owens', 'Siddhartha Kadia'));
  assert.ok(!sameHuman('John Sakys', 'John Sullivan'));
});

test('the roster names the officer, the proxy pays them', () => {
  const parsed = {
    ceo: { name: 'Gary Owens', title: 'Former CEO and President', age: 58, totalComp: '6643208' },
    execs: [
      { name: 'Gary Owens', title: 'Former CEO and President', age: 58, since: 2017, totalComp: '6643208' },
      { name: 'John Sakys', title: 'VP and Chief Financial Officer', age: 57, since: 2012, totalComp: '2471543' },
    ],
  };
  const roster = {
    asOf: '2026-06-23',
    officers: [
      { name: 'Siddhartha Kadia', filedName: 'Kadia Siddhartha', title: 'President and CEO',
        office: 'ceo', isOfficer: true, lastFiledAt: '2026-04-24', form3At: '2026-04-24' },
      { name: 'John Sakys', filedName: 'Sakys John', title: 'CFO', office: 'cfo',
        isOfficer: true, lastFiledAt: '2026-06-23', form3At: null },
      { name: 'Gary M Owens', filedName: 'Owens Gary M', title: 'President and CEO', office: 'ceo',
        isOfficer: true, lastFiledAt: '2026-04-02', former: true,
        supersededBy: 'Siddhartha Kadia', supersededBy_at: '2026-04-24' },
    ],
    events: [],
  };
  const out = mergeLeadership(parsed, roster, { proxyFiledAt: '2026-07-22' });

  // The headline fact: the panel now names the man in the job.
  assert.equal(out.ceo.name, 'Siddhartha Kadia');
  assert.equal(out.ceo.title, 'President and CEO');
  // The departed CEO is off the staff list, not silently deleted.
  assert.ok(!out.execs.some((e) => e.name === 'Gary M Owens'));
  assert.equal(out.leadership.former[0].name, 'Gary M Owens');
  assert.equal(out.leadership.former[0].supersededBy, 'Siddhartha Kadia');
  assert.equal(out.leadership.changedSinceProxy, true);
  // Pay survives the merge for anyone the proxy did cover.
  const cfo = out.execs.find((e) => e.office === 'cfo');
  assert.equal(cfo.totalComp, '2471543');
  assert.equal(cfo.since, 2012);
  // The new CEO has no pay figure and must not borrow the old one.
  assert.equal(out.ceo.totalComp, null);
  assert.equal(out.ceo.inProxy, false);
});

test('no roster leaves the proxy exactly as it was', () => {
  const parsed = { ceo: { name: 'A' }, execs: [{ name: 'A' }] };
  const out = mergeLeadership(parsed, null, { proxyFiledAt: '2026-07-22' });
  assert.equal(out.ceo.name, 'A');
  assert.equal(out.execs.length, 1);
  assert.equal(out.leadership.source, 'proxy');
  assert.equal(out.leadership.changedSinceProxy, false);
});

test('directors the proxy parse missed are filled in from filings', () => {
  const board = [{ name: 'Peter C Wallace', bio: 'long bio' }];
  const roster = { officers: [
    { name: 'Peter C Wallace', filedName: 'Wallace Peter C', isDirector: true },
    { name: 'Mary Dean Hall', filedName: 'Hall Mary Dean', isDirector: true },
    { name: 'John Sakys', filedName: 'Sakys John', isDirector: false, isOfficer: true },
  ] };
  const merged = mergeBoard(board, roster);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].bio, 'long bio');
  assert.equal(merged[1].name, 'Mary Dean Hall');
  assert.equal(merged[1]._source, 'ownership');
});
