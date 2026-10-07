// The acronym, as its own word. "segment", "SEGMENT" and the internal
// source key "seg13f" are different words and are not this. Punctuation
// and the em dash in "Lowes — SEG historical file" do not glue the
// acronym to the company name, so that title matches.
const SEG_LABEL = /(?:^|[^A-Za-z0-9])SEG(?:[^A-Za-z0-9]|$)/i;

/**
 * True when `value` contains the acronym as a label. Null and empty
 * are clean. Case does not matter; a letter or digit on either side
 * does, which is what keeps ordinary English out of the filter.
 */
export function mentionsSegLabel(value) {
  return SEG_LABEL.test(String(value ?? ''));
}

// What a member reads as the project's identity. A hit on any of them
// is the project, so the whole row leaves every list. The ticker is
// deliberately not one of these: a symbol is not this label, and
// hiding a holding because of its ticker would take a name off the book.
const PROJECT_FIELDS = ['name', 'brief', 'aims', 'folder'];

export function projectCarriesSegLabel(project) {
  if (!project || typeof project !== 'object') return false;
  return PROJECT_FIELDS.some((field) => mentionsSegLabel(project[field]));
}

export function withoutSegProjects(projects) {
  return (projects || []).filter((p) => !projectCarriesSegLabel(p));
}

export function omitSegLabeled(rows, fields) {
  if (!Array.isArray(rows)) return rows;
  return rows.filter((row) => !fields.some((field) => mentionsSegLabel(row?.[field])));
}

export function claimCarriesSegLabel(claim) {
  return mentionsSegLabel(claim?.text)
    || mentionsSegLabel(claim?.quote)
    || mentionsSegLabel(claim?.topic)
    || mentionsSegLabel(claim?.interview?.title);
}

/**
 * Drop the project, or the labeled children inside one we are keeping.
 *
 * `ownerOnly` is the wrong switch for this. It still renders for the
 * super admin, and the super admin is who opens Fieldwork and asked
 * for the label to be gone. The rows stay in the database; they stop
 * being sent. Returns null for a project whose own identity carries
 * the label, which the caller answers as a missing project so a direct
 * link does not confirm the row.
 */
export function stripSegLabels(project) {
  if (!project || projectCarriesSegLabel(project)) return null;
  const drop = (rows, fields) => omitSegLabeled(rows, fields);
  if (Array.isArray(project.artifacts)) {
    project.artifacts = drop(project.artifacts, ['title', 'filename']);
  }
  if (Array.isArray(project.interviews)) {
    project.interviews = drop(project.interviews, ['title']);
  }
  if (Array.isArray(project.questions)) {
    project.questions = drop(project.questions, ['text']);
  }
  if (Array.isArray(project.valuations)) {
    project.valuations = drop(project.valuations, ['name']);
  }
  if (Array.isArray(project.visits)) {
    project.visits = drop(project.visits, ['location', 'banner']).map((v) => ({
      ...v,
      siteObservations: drop(v.siteObservations || [], ['text']),
    }));
  }
  if (Array.isArray(project.targets)) {
    project.targets = drop(project.targets, ['name']).map((t) => ({
      ...t,
      drafts: drop(t.drafts, ['subject', 'body', 'sentBody']),
      messages: drop(t.messages, ['subject', 'body']),
    }));
  }
  return project;
}
