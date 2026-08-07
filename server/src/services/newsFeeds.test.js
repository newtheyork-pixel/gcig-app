import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, getWireHeadlines } from './newsFeeds.js';

// Publishers are inconsistent in ways that only show up in production:
// CDATA wrappers, hex entities for curly quotes, Atom instead of RSS,
// items with no link. The parser has to survive all of it and skip what
// it can't use rather than throw and cost us the feed.

const FEED = { id: 'test', source: 'Test Wire', url: 'http://x', weight: 'wire' };

// Pinned "now" so the fixtures' dates stay inside the parser's max-age
// window forever instead of rotting out of it.
const NOW = new Date('2026-07-25T00:00:00Z').getTime();

test('parses a plain RSS item', () => {
  const [a] = parseFeed(
    `<rss><channel><item>
      <title>Fed cuts rates by 50 basis points</title>
      <link>https://example.com/a</link>
      <pubDate>Wed, 23 Jul 2026 14:30:00 GMT</pubDate>
      <description>The FOMC moved early.</description>
    </item></channel></rss>`,
    FEED,
    NOW
  );
  assert.equal(a.title, 'Fed cuts rates by 50 basis points');
  assert.equal(a.url, 'https://example.com/a');
  assert.equal(a.source, 'Test Wire');
  assert.equal(a.description, 'The FOMC moved early.');
  assert.equal(a.publishedAt, '2026-07-23T14:30:00.000Z');
});

test('unwraps CDATA', () => {
  const [a] = parseFeed(
    `<item><title><![CDATA[Stocks & bonds rally]]></title><link>https://e.com/b</link></item>`,
    FEED
  );
  assert.equal(a.title, 'Stocks & bonds rally');
});

test('decodes hex and decimal numeric entities', () => {
  // The exact breakage seen from Dow Jones feeds: curly apostrophes
  // arriving as &#x2019; and rendering raw in the ticker.
  const [a] = parseFeed(
    `<item><title>Here&#x2019;s the net worth you&#8217;ll need</title><link>https://e.com/c</link></item>`,
    FEED
  );
  assert.equal(a.title, 'Here’s the net worth you’ll need');
});

test('decodes named entities, ampersand last', () => {
  const [a] = parseFeed(
    `<item><title>AT&amp;T &lt;the telco&gt; &quot;wins&quot;</title><link>https://e.com/d</link></item>`,
    FEED
  );
  assert.equal(a.title, 'AT&T <the telco> "wins"');
});

test('a double-escaped ampersand does not become a live entity', () => {
  // &amp;lt; must render the literal text "&lt;", not a "<" character.
  const [a] = parseFeed(
    `<item><title>a &amp;lt; b</title><link>https://e.com/e</link></item>`,
    FEED
  );
  assert.equal(a.title, 'a &lt; b');
});

test('handles Atom entries with href links', () => {
  const [a] = parseFeed(
    `<feed><entry>
      <title>Treasury announces buyback</title>
      <link rel="alternate" href="https://e.com/atom"/>
      <updated>2026-07-24T09:00:00Z</updated>
    </entry></feed>`,
    FEED,
    NOW
  );
  assert.equal(a.url, 'https://e.com/atom');
  assert.equal(a.publishedAt, '2026-07-24T09:00:00.000Z');
});

test('skips items with no title or no link', () => {
  const out = parseFeed(
    `<item><title>No link here</title></item>
     <item><link>https://e.com/f</link></item>
     <item><title>Good</title><link>https://e.com/g</link></item>`,
    FEED
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Good');
});

test('an unparseable body yields no items rather than throwing', () => {
  for (const junk of ['', null, undefined, '<html>not a feed</html>', '{"json":true}']) {
    assert.deepEqual(parseFeed(junk, FEED), []);
  }
});

test('an undated item still parses, with a null timestamp', () => {
  const [a] = parseFeed(`<item><title>T</title><link>https://e.com/h</link></item>`, FEED);
  assert.equal(a.publishedAt, null);
});

test('items older than the max age are dropped at parse', () => {
  // The WSJ freeze: a feed serving HTTP 200 with content stuck in the
  // past must contribute nothing, not eighteen-month-old headlines.
  const out = parseFeed(
    `<item><title>Ancient</title><link>https://e.com/old</link>
       <pubDate>Mon, 27 Jan 2025 14:27:15 -0500</pubDate></item>
     <item><title>Fresh</title><link>https://e.com/new</link>
       <pubDate>Fri, 24 Jul 2026 12:00:00 GMT</pubDate></item>`,
    FEED,
    NOW
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Fresh');
});

test('mixed text and CDATA in one tag keeps both parts', () => {
  const [a] = parseFeed(
    `<item><title>Breaking: <![CDATA[X & Y]]></title><link>https://e.com/mix</link></item>`,
    FEED
  );
  assert.equal(a.title, 'Breaking: X & Y');
});

test('merges feeds newest-first and dedupes on URL ignoring query strings', async () => {
  const feeds = [
    { id: 'a', source: 'A', url: 'http://a', weight: 'wire' },
    { id: 'b', source: 'B', url: 'http://b', weight: 'wire' },
  ];
  const fetchFeed = async (f) =>
    f.id === 'a'
      ? [
          { title: 'old', url: 'https://x.com/1', publishedAt: '2026-07-01T00:00:00Z', source: 'A' },
          { title: 'new', url: 'https://x.com/2', publishedAt: '2026-07-05T00:00:00Z', source: 'A' },
        ]
      : [
          // Same story as x.com/1, syndicated with a tracking param.
          { title: 'dupe', url: 'https://x.com/1?utm_source=b', publishedAt: '2026-07-02T00:00:00Z', source: 'B' },
        ];

  const out = await getWireHeadlines({ feeds, fetchFeed });
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'new'); // newest first
  assert.equal(out[1].title, 'old'); // the ?utm_source copy was dropped
});

test('one dead feed does not take down the rest', async () => {
  const feeds = [
    { id: 'dead', source: 'D', url: 'http://d', weight: 'wire' },
    { id: 'live', source: 'L', url: 'http://l', weight: 'wire' },
  ];
  const fetchFeed = async (f) => {
    if (f.id === 'dead') return []; // fetchFeed swallows its own errors
    return [{ title: 'survived', url: 'https://x.com/9', publishedAt: null, source: 'L' }];
  };
  const out = await getWireHeadlines({ feeds, fetchFeed });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'survived');
});
