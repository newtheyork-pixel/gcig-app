// Terminal function registry. Each entry is a Bloomberg-style mnemonic
// (DES, GP, CN, BI, etc.) with metadata and the React component that renders
// the panel for it. Adding a new function = adding one entry here plus one
// component file under ./functions/.

import Description from './functions/Description.jsx';
import Chart from './functions/Chart.jsx';
import Intraday from './functions/Intraday.jsx';
import Fundamentals from './functions/Fundamentals.jsx';
import Financials from './functions/Financials.jsx';
import News from './functions/News.jsx';
import BloombergIntelligence from './functions/BloombergIntelligence.jsx';
import Help from './functions/Help.jsx';
import Movers from './functions/Movers.jsx';
import Peers from './functions/Peers.jsx';
import InsiderActivity from './functions/InsiderActivity.jsx';
import Filings from './functions/Filings.jsx';
import Earnings from './functions/Earnings.jsx';
import Consensus from './functions/Consensus.jsx';
import Compare from './functions/Compare.jsx';
import InsiderClusters from './functions/InsiderClusters.jsx';
import Notes from './functions/Notes.jsx';
import Governance from './functions/Governance.jsx';
import TopNews from './functions/TopNews.jsx';
import WorldIndices from './functions/WorldIndices.jsx';
import WeatherImpact from './functions/WeatherImpact.jsx';
import WeatherRadar from './functions/WeatherRadar.jsx';
import MacroSensitivity from './functions/MacroSensitivity.jsx';
import Portfolio from './functions/Portfolio.jsx';
import SupplyChain from './functions/SupplyChain.jsx';
import Research from './functions/Research.jsx';
import FieldWork from './functions/FieldWork.jsx';
import ComingSoon from './functions/ComingSoon.jsx';
import Organization from './functions/Organization.jsx';
import Alerts from './functions/Alerts.jsx';
import EarningsCalendar from './functions/EarningsCalendar.jsx';
import Status from './functions/Status.jsx';
import Dividends from './functions/Dividends.jsx';
import Correlation from './functions/Correlation.jsx';
import Economic from './functions/Economic.jsx';
import ShortInterest from './functions/ShortInterest.jsx';
import Halts from './functions/Halts.jsx';

export const FUNCTIONS = [
  {
    id: 'DES',
    label: 'Description',
    help: 'Company snapshot: quote, fundamentals, business summary, AI brief.',
    requires: 'ticker',
    component: Description,
  },
  {
    id: 'GP',
    label: 'Chart',
    help: 'Price chart with selectable interval.',
    requires: 'ticker',
    component: Chart,
  },
  {
    id: 'GIP',
    label: 'Intraday Price',
    help: "Today's intraday price line (pre/post-market) vs prior close.",
    requires: 'ticker',
    component: Intraday,
  },
  {
    id: 'CN',
    label: 'Company News',
    help: 'Latest news headlines for the focused ticker.',
    requires: 'ticker',
    component: News,
    // News panes spawn wider/taller than the default — headlines are
    // single-line and truncate hard in a 580px window.
    w: 720,
    h: 560,
  },
  {
    id: 'BI',
    label: 'Bloomberg Intelligence',
    help: 'Free-form research chat with workspace context.',
    requires: null,
    component: BloombergIntelligence,
  },
  {
    id: 'HELP',
    label: 'Help',
    help: 'List of available terminal functions.',
    requires: null,
    component: Help,
  },
  { id: 'FA', label: 'Financial Analysis', help: 'Income, balance sheet & cash flow line by line (SEC XBRL), annual or quarterly.', requires: 'ticker', component: Financials },
  { id: 'GF', label: 'Graph Fundamentals', help: 'Revenue, margins, EPS & cash flow over time (SEC XBRL).', requires: 'ticker', component: Fundamentals },
  { id: 'PEER', label: 'Peers', help: 'Sector peer comparison table.', requires: 'ticker', component: Peers },
  { id: 'INSDR', label: 'Insider Activity', help: 'Form 4 insider buys/sells on the price chart.', requires: 'ticker', component: InsiderActivity },
  { id: 'FIL', label: 'Filings', help: 'Recent SEC filings (8-K/10-Q/10-K/DEF 14A/Form 4) with an AI read.', requires: 'ticker', component: Filings },
  { id: 'EARN', label: 'Earnings', help: 'Next report + trailing EPS beat/miss history.', requires: 'ticker', component: Earnings },
  { id: 'CON', label: 'Analyst Consensus', help: 'Buy/hold/sell breakdown & trend.', requires: 'ticker', component: Consensus },
  { id: 'CMP', label: 'Compare', help: '2–4 tickers side by side: live price, day %, valuation.', requires: null, component: Compare },
  { id: 'ICLUSTER', label: 'Insider Clusters', help: 'Multi-insider buy clusters across your book (last 60d).', requires: null, component: InsiderClusters },
  { id: 'NOTE', label: 'Notes', help: 'Your private research notes for this ticker (saved to your profile).', requires: 'ticker', component: Notes },
  // The whole research effort on a company, whatever form it takes:
  // the brief and the questions, who we contacted, interviews and
  // transcripts, site visits, the valuation model, the filings and data
  // behind it, and the claim ledger. Ticker-optional — `RSCH` lists
  // every project, `AIT RSCH` scopes to one name. Wide and tall because
  // it is a workspace, not a readout.
  //
  // It answered to FLD while it was only fieldwork. FLD still opens it,
  // because a code someone has in their fingers should not stop working
  // to serve a rename.
  { id: 'RSCH', aliases: ['FLD'], label: 'Research', help: 'Everything on one name: the brief and questions, outreach, interviews and transcripts, site visits, valuation models, filings and data, and the claim ledger with every claim pinned to a source and timestamp.', requires: null, component: FieldWork, w: 860, h: 680 },
  // Ticker-optional: `ARCH` opens the whole archive, `AIT ARCH` scopes
  // it. Wider/taller than the default because this pane is read, not
  // scanned — prose at 580px wraps every few words. RSCH is the work and
  // the evidence; ARCH is what we already wrote up from it.
  { id: 'ARCH', label: 'Archive', help: 'The club\'s own reports & pitch decks — full text and AI summaries, readable inline.', requires: null, component: Research, w: 800, h: 640 },
  { id: 'MGMT', label: 'Management & Board', help: 'CEO, board, comp & interlocking boards from the latest DEF 14A.', requires: 'ticker', component: Governance },
  { id: 'WEI', label: 'World Indices', help: 'Global index snapshot.', requires: null, component: WorldIndices },
  { id: 'TOP', label: 'Top News', help: 'Market-wide top headlines.', requires: null, component: TopNews, w: 780, h: 620 },
  { id: 'MOVR', label: 'Movers', help: 'Day\'s biggest gainers and losers.', requires: null, component: Movers },
  { id: 'ALRT', label: 'Policy Alerts', help: 'The book checked against the club\'s own IPS: position caps, cash floor, drawdown review rules. A rule that could not run says so.', requires: null, component: Alerts, w: 640, h: 520 },
  { id: 'EVTS', label: 'Earnings Calendar', help: 'When every holding reports, next 60 days, with before-open/after-close timing.', requires: null, component: EarningsCalendar, w: 720, h: 520 },
  { id: 'HALT', label: 'Trading Halts', help: 'Live Nasdaq + NYSE halt tape: active halts with decoded reasons, today\'s resumptions, held names flagged.', requires: null, component: Halts, w: 720, h: 560 },
  { id: 'SI', label: 'Short Interest', help: 'Bi-monthly shares short, change and days to cover (FINRA consolidated), plus the latest day\'s off-exchange short-volume %.', requires: 'ticker', component: ShortInterest },
  { id: 'CORR', label: 'Correlation', help: 'Pairwise correlation of daily log returns across the book (3m/1y), plus each name\'s correlation to the rest of the book. Stored bars, close-to-close, dividends excluded.', requires: null, component: Correlation, w: 800, h: 620 },
  { id: 'DVD', label: 'Dividend History', help: 'Cash dividend history: ex/pay/record/declared dates, amount, raises and cuts. Nasdaq-listed names only.', requires: 'ticker', component: Dividends },
  { id: 'STAT', label: 'System Status', help: 'The terminal on itself: quote scheduler health and per-wire news feed liveness.', requires: null, component: Status, w: 560, h: 480 },
  { id: 'PM', label: 'Portfolio Manager', help: 'The whole book: positions, weights, live value & P&L, sector allocation.', requires: null, component: Portfolio },
  { id: 'SPLC', label: 'Supply Chain', help: 'Customers, suppliers & key inputs from the latest 10-K, with stated revenue concentration.', requires: 'ticker', component: SupplyChain },
  { id: 'ECO', label: 'Economic Calendar', help: 'Upcoming FRED releases (next 14 days, key prints bold) and recent macro readings. FRED carries no consensus, so forecasts render a dash.', requires: null, component: Economic, w: 700, h: 560 },
  { id: 'WX', label: 'Weather Impact', help: 'Named-storm event impact on your Gulf O&G + insurer exposure.', requires: null, component: WeatherImpact },
  { id: 'RDR', label: 'Weather Radar', help: 'Live US NEXRAD radar + active NWS warnings.', requires: null, component: WeatherRadar },
  // PM-and-above inside the panel itself — the terminal gate is
  // Analyst+, and the full roster with roles is leadership information.
  { id: 'ORG', label: 'Organization', help: 'The club org chart: leadership tiers, industry groups, everyone one click from their profile. PM and above.', requires: null, component: Organization, w: 720, h: 660 },
  { id: 'MACRO', label: 'Macro Sensitivity', help: 'Portfolio sensitivity to 10Y, oil, USD, VIX, SPY (1y OLS).', requires: null, component: MacroSensitivity },
];

// Aliases resolve to the same function but are deliberately kept out of
// FUNCTIONS itself, so a retired code still works from the command bar
// without showing up twice in the function list or the autocomplete.
export const FUNCTION_BY_ID = Object.fromEntries(
  FUNCTIONS.flatMap((f) => [[f.id, f], ...(f.aliases || []).map((a) => [a, f])])
);
export const FUNCTION_IDS = new Set(Object.keys(FUNCTION_BY_ID));

export function getFunction(id) {
  return FUNCTION_BY_ID[String(id || '').toUpperCase()] || null;
}
