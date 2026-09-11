// Which recording rule a call falls under, and therefore what happens to
// the tape.
//
// This used to be a picker in the panel, which was the wrong shape: it
// asked an analyst mid-call to make a legal judgement about a state they
// had not looked up, and the safe default then applied to every call
// including the ones where the tape was the point.
//
// Two rules, and the second is the one people get wrong.
//
// THE OFFENSE IS THE RECORDING, NOT THE KEEPING. Deleting audio after
// transcribing it does not cure an all-party state, and the transcript
// is the thing a report would cite. So the disclosure is read on EVERY
// call, which makes the recording lawful everywhere, and this table then
// decides only whether the audio survives the transcript.
//
// THE STRICTER END WINS. A call from New York to a store in California
// touches both states. Taking only the store's rule, or only ours, picks
// the answer that happens to be convenient; taking the stricter of the
// two is the reading that does not depend on which end you thought of as
// the important one.
//
// Source: the Reporters Committee for Freedom of the Press, Reporter's
// Recording Guide (https://www.rcfp.org/reporters-recording-guide/). Its
// eleven all-party states, plus Connecticut and Nevada, which require
// all-party consent for PHONE CALLS specifically while allowing
// one-party for in-person conversation. Missouri and Oregon are the
// mirror image (all-party in person, one-party by phone) and so are not
// here. Hawaii and Maine require all-party only in private places, which
// a retail store's published number is not.
//
// This list is a starting point a person maintains, not legal advice,
// and it is wrong the day a legislature changes it. It is deliberately
// biased: anything unknown reads as all-party.

/** All-party consent for a TELEPHONE call. */
export const ALL_PARTY_PHONE_STATES = new Set([
  'CA', // California
  'CT', // Connecticut (phone calls; one-party in person)
  'DE', // Delaware
  'FL', // Florida
  'IL', // Illinois
  'MD', // Maryland
  'MA', // Massachusetts
  'MI', // Michigan
  'MT', // Montana
  'NH', // New Hampshire
  'NV', // Nevada (phone calls; one-party in person)
  'PA', // Pennsylvania
  'WA', // Washington
]);

/** Where the club calls from, unless a caller says otherwise. */
export const HOME_STATE = (process.env.CLUB_HOME_STATE || 'NY').toUpperCase();

function normalize(state) {
  if (!state) return null;
  const s = String(state).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

/**
 * @param {object} ends
 * @param {string} [ends.storeState]  where the phone rings
 * @param {string} [ends.callerState] where the analyst is sitting
 * @returns {{ regime: 'one-party'|'all-party', reason: string, unknownEnd: boolean }}
 */
export function regimeFor({ storeState, callerState } = {}) {
  const store = normalize(storeState);
  const caller = normalize(callerState) || HOME_STATE;

  // An end nobody established is not a licence. A store whose state was
  // never filled in is treated as the strict case, which costs a deleted
  // recording and never costs an unlawful one.
  if (!store) {
    return {
      regime: 'all-party',
      reason: 'No state recorded for this store, so the stricter rule applies.',
      unknownEnd: true,
    };
  }

  const strict = [store, caller].filter((s) => ALL_PARTY_PHONE_STATES.has(s));
  if (strict.length > 0) {
    return {
      regime: 'all-party',
      reason: `${strict.join(' and ')} ${strict.length > 1 ? 'require' : 'requires'} every party to agree, `
        + 'so the tape goes once it is transcribed.',
      unknownEnd: false,
    };
  }
  return {
    regime: 'one-party',
    reason: `${caller} and ${store} are both one-party, so the recording is kept.`,
    unknownEnd: false,
  };
}
