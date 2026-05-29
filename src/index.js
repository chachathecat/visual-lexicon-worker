// Visual Lexicon staging worker for Session 2C
//
// This worker extends the Session 2B‑2 staging worker with chunked export
// and finalisation endpoints.  It continues to use Webflow’s v2 API to
// fetch CMS items, normalises them into a quiz‑pack schema, and writes
// results into a staging R2 bucket without touching production routes.
//
// Key endpoints:
//   GET /health
//     – simple liveness check.
//
//   GET /admin/debug-webflow-fetch?limit=5&offset=0
//     – attempts to fetch a small sample from Webflow via v2_live, v2_staged
//       and v1_legacy endpoints and returns diagnostics (HTTP status,
//       response keys, error messages, etc.).  Useful to verify API access.
//
//   GET /admin/debug-webflow-fields?limit=5&offset=0[&sample=spread]
//     – fetches a sample of CMS items and exposes their top-level keys and
//       fieldData keys/values for inspection.  Use this to understand
//       available CMS fields before mapping.
//
//   GET /admin/test-webflow?limit=100&offset=0
//     – validation endpoint: fetches up to `limit` CMS items, normalises
//       them and writes a set of staging files (manifest/core/summary,
//       word-index, per-word and per-hub).  Should be used only for
//       small-scale tests; repeated calls will overwrite staging files.
//
//   GET /admin/export-webflow-chunk?runId=RUN&offset=0&limit=1000
//     – chunked export endpoint: fetches a block of CMS items starting
//       at `offset` with size `limit` (max 1000), normalises them and
//       writes the chunk into run-specific folders in the staging bucket.
//       A chunk manifest is also written summarising counts.  Per-word
//       files are written into the run’s `words/` folder.  Does not
//       overwrite the main staging quiz‑pack; instead builds up data
//       for later finalisation.
//
//   GET /admin/finalize-export?runId=RUN
//     – finalisation endpoint: reads all chunk files for the given runId,
//       deduplicates words on slug, aggregates counts, constructs the
//       final quiz‑pack files, per-word files and SEO files, writes them to
//       the top-level staging prefix, and returns a summary.  WARNING: this
//       may timeout on large datasets.
//
//   GET /admin/finalize-export-core?runId=RUN
//     – core finalisation endpoint: aggregates all chunks, writes core/home
//       datasets, manifest/summary, SEO files and per‑hub files.  It does not
//       write per-word final files.
//
//   GET /admin/finalize-word-files-chunk?runId=RUN&chunkOffset=OFFSET
//     – copies per‑word files from a single chunk into the final
//       quiz‑pack/words prefix.  Call this separately for each chunk offset
//       (e.g. 0, 1000, 2000…) after running finalize-export-core.
//
//   Note: All endpoints write only to the staging bucket and never touch
//   production.

// === Rich Text extraction and normalisation helpers ===
// List of keys to consider when extracting rich text content from a CMS item.
const RICH_TEXT_KEYS = ['blogContent', 'blog-content', 'richText', 'body', 'content', 'longDescription', 'article'];

/**
 * Extract concatenated rich text content from known field keys. Returns a single
 * string containing the joined values of any matching fields.
 *
 * @param {object} fields
 * @returns {string}
 */
function extractRichTextFromFields(fields) {
  let rich = '';
  for (const key of RICH_TEXT_KEYS) {
    if (fields && fields[key]) {
      const val = fields[key];
      if (typeof val === 'string') {
        rich += ' ' + val;
      }
    }
  }
  return rich.trim();
}

/**
 * Parse lexicon sections (definition, examples, synonyms, antonyms, related terms)
 * from a block of HTML or plain text.  This function attempts to detect headings
 * and section labels to categorise subsequent lines into appropriate arrays.
 *
 * @param {string} rawHtmlOrText
 * @returns {object} An object with keys: definition (string|null), examples (array), synonyms (array), antonyms (array), relatedTerms (array)
 */
function extractLexiconSectionsFromRichText(rawHtmlOrText) {
  if (!rawHtmlOrText || typeof rawHtmlOrText !== 'string') {
    return { definition: null, examples: [], synonyms: [], antonyms: [], relatedTerms: [] };
  }
  // Convert HTML tags into newlines and strip any remaining tags.
  let text = String(rawHtmlOrText)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/p\s*>/gi, '\n')
    .replace(/<\s*p\b[^>]*>/gi, '')
    .replace(/<\s*\/h[1-6]\s*>/gi, '\n')
    .replace(/<\s*h[1-6]\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  // Normalise CRLF to LF
  text = text.replace(/\r\n?/g, '\n');
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  let current = null;
  const definitionParts = [];
  const examples = [];
  const synonyms = [];
  const antonyms = [];
  const related = [];
  // Helper to split a line into tokens and push into array
  const pushTokens = (arr, line) => {
    line.split(/[•\u2022\u2023\u25E6\-–—;,]/g).forEach(tok => {
      const t = tok.trim();
      if (t) arr.push(t);
    });
  };
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (/\bdefinition\b/.test(lower)) {
      current = 'definition';
      continue;
    }
    if (/\bexample\b/.test(lower)) {
      current = 'examples';
      continue;
    }
    if (/\bsynonym\b/.test(lower)) {
      current = 'synonyms';
      continue;
    }
    if (/\bantonym\b/.test(lower)) {
      current = 'antonyms';
      continue;
    }
    if (/\brelated\b/.test(lower)) {
      current = 'related';
      continue;
    }
    if (/^synonyms?:\s*/i.test(line)) {
      current = 'synonyms';
      pushTokens(synonyms, line.replace(/^synonyms?:\s*/i, ''));
      continue;
    }
    if (/^antonyms?:\s*/i.test(line)) {
      current = 'antonyms';
      pushTokens(antonyms, line.replace(/^antonyms?:\s*/i, ''));
      continue;
    }
    if (/^related\s*(terms|words)?:\s*/i.test(line)) {
      current = 'related';
      pushTokens(related, line.replace(/^related\s*(terms|words)?:\s*/i, ''));
      continue;
    }
    // Depending on current section, push into appropriate arrays
    if (current === 'definition') {
      definitionParts.push(line);
    } else if (current === 'examples') {
      examples.push(line);
    } else if (current === 'synonyms') {
      pushTokens(synonyms, line);
    } else if (current === 'antonyms') {
      pushTokens(antonyms, line);
    } else if (current === 'related') {
      pushTokens(related, line);
    }
  }
  // Helper to slugify and deduplicate terms
  function slugifyTerms(arr) {
    const out = [];
    const seen = new Set();
    for (const term of arr) {
      const slug = toSlug(term);
      if (slug && !seen.has(slug)) {
        seen.add(slug);
        out.push(slug);
      }
    }
    return out;
  }
  return {
    definition: definitionParts.join(' ').trim() || null,
    examples: examples,
    synonyms: slugifyTerms(synonyms),
    antonyms: slugifyTerms(antonyms),
    relatedTerms: slugifyTerms(related),
  };
}

/**
 * Deduplicate an array of strings.
 * @param {Array<string>} arr
 * @returns {Array<string>}
 */
function uniqueArray(arr) {
  return Array.from(new Set((Array.isArray(arr) ? arr : []).filter(v => v)));
}

/**
 * Merge two relation arrays (e.g. synonyms) and deduplicate. Both arguments may be undefined.
 * @param {Array<string>} original
 * @param {Array<string>} extracted
 * @returns {Array<string>}
 */
function mergeRelationArrays(original, extracted) {
  const set = new Set();
  (Array.isArray(original) ? original : []).forEach(v => { if (v) set.add(v); });
  (Array.isArray(extracted) ? extracted : []).forEach(v => { if (v) set.add(v); });
  return Array.from(set);
}

/**
 * Convert an arbitrary term into a slug suitable for use as a Word slug.
 * Lowercases, replaces non-alphanumeric characters with hyphens and trims hyphens.
 * @param {string} term
 * @returns {string}
 */
function toSlug(term) {
  if (!term || typeof term !== 'string') return '';
  return term
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Normalise a CMS item into a quiz‑pack word schema.  Extracts definition, examples,
 * synonyms, antonyms and related terms from both explicit fields and from rich text.
 * Returns null if there is no slug or no word.
 * @param {object} item
 * @returns {object|null}
 */
function normaliseCmsItem(item) {
  if (!item) return null;
  const fields = item.fieldData || item.fields || item || {};
  const slug = fields.slug || fields.slug_lowercase;
  const word = fields.word || fields.name || fields.headword || '';
  if (!slug || !word) return null;
  // Base values from explicit fields
  let definition = fields.definition || fields.definitions || fields.meaning || null;
  let example = fields.example || fields.usage || null;
  let examples = Array.isArray(fields.examples) ? fields.examples.filter(v => v) : [];
  const parseList = (val) => {
    if (!val) return [];
    if (Array.isArray(val)) {
      return val.map(v => toSlug(String(v))).filter(v => v);
    }
    return String(val).split(/[,;]/g).map(v => toSlug(v.trim())).filter(v => v);
  };
  let synonyms = parseList(fields.synonyms);
  let antonyms = parseList(fields.antonyms);
  let related = parseList(fields.related);
  let confusables = parseList(fields.confusables);
  // Extract and parse any rich text content
  const richText = extractRichTextFromFields(fields);
  const extracted = extractLexiconSectionsFromRichText(richText);
  if (extracted.definition && !definition) definition = extracted.definition;
  if (extracted.examples && extracted.examples.length > 0) {
    if (!example) example = extracted.examples[0];
    if (examples.length === 0) examples = extracted.examples;
  }
  synonyms = mergeRelationArrays(synonyms, extracted.synonyms);
  antonyms = mergeRelationArrays(antonyms, extracted.antonyms);
  related = mergeRelationArrays(related, extracted.relatedTerms);
  return {
    slug: toSlug(slug),
    word,
    headword: fields.headword || word,
    definition,
    example,
    examples,
    image: fields.image || null,
    audio: fields.audio || null,
    hub: fields.hub || fields.hubId || null,
    level: fields.level || fields.difficulty || fields.levels || null,
    pos: fields.pos || fields.partOfSpeech || fields.partOfSpeechCode || null,
    synonyms,
    antonyms,
    related,
    confusables,
    richTextExtracted: extracted,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Liveness probe
    if (url.pathname === '/health') {
      return jsonResponse({ ok: true });
    }
    // Fetch diagnostics (v2_live, v2_staged, v1_legacy)
    if (url.pathname.startsWith('/admin/debug-webflow-fetch')) {
      const limit = parseInt(url.searchParams.get('limit') || '5', 10);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      return handleDebugFetch(env, limit, offset);
    }
    // Field diagnostics (list keys and non-empty fieldData values)
    if (url.pathname.startsWith('/admin/debug-webflow-fields')) {
      const limit = parseInt(url.searchParams.get('limit') || '5', 10);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const spread = url.searchParams.get('sample') === 'spread';
      return handleDebugWebflowFields(env, limit, offset, spread);
    }
    // Debug Rich Text extraction: extract lexicon sections from the core dataset
    if (url.pathname.startsWith('/admin/debug-rich-text-sections')) {
      const slug = url.searchParams.get('slug');
      return handleDebugRichTextSections(env, slug);
    }
    // Related graph word debug: inspect outbound and inbound edges for a given slug in a run
    if (url.pathname.startsWith('/admin/related-graph/debug-word')) {
      const runId = url.searchParams.get('runId');
      const s = url.searchParams.get('slug');
      return handleRelatedGraphDebugWord(env, runId, s);
    }
    // Test export (small scale validation)
    if (url.pathname.startsWith('/admin/test-webflow')) {
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      return handleTestExport(env, limit, offset, url.origin);
    }
    // Chunked export
    if (url.pathname.startsWith('/admin/export-webflow-chunk')) {
      const runId = url.searchParams.get('runId');
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const limit = parseInt(url.searchParams.get('limit') || '1000', 10);
      return handleExportChunk(env, runId, offset, limit);
    }
        // Serve staging files directly from R2 (read-only).  This makes it
    // possible to fetch JSON/XML files in the staging prefix via HTTP.
    if (url.pathname.startsWith('/staging/')) {
      return handleServeStaging(env, url.pathname);
    }

    // Export integrity status: returns state of audit tasks and which report files exist.
    if (url.pathname.startsWith('/admin/export-integrity/status')) {
      const runId = url.searchParams.get('runId');
      return handleExportIntegrityStatus(env, runId);
    }
    // Export integrity audit: performs an audit of the generated export files, writes JSON/MD reports.
    if (url.pathname.startsWith('/admin/export-integrity/audit')) {
      const runId = url.searchParams.get('runId');
      return handleExportIntegrityAudit(env, runId, url.origin);
    }
    // Export integrity verify: checks whether the audit reports exist.
    if (url.pathname.startsWith('/admin/export-integrity/verify')) {
      const runId = url.searchParams.get('runId');
      return handleExportIntegrityVerify(env, runId);
    }

    // Related graph endpoints: orchestrate the preparation, build and verification of the related graph.
    // Status endpoint: returns current state of the related graph build. Determines which step should run next.
    if (url.pathname.startsWith('/admin/related-graph/status')) {
      const runId = url.searchParams.get('runId');
      return handleRelatedGraphStatus(env, runId);
    }
    // Prepare endpoint: read audit report and core dataset, calculate eligible slugs and write build plan.
    if (url.pathname.startsWith('/admin/related-graph/prepare')) {
      const runId = url.searchParams.get('runId');
      return handleRelatedGraphPrepare(env, runId);
    }
    // Build-index endpoint: compute the semantic graph for eligible words and write aggregated graph and reports.
    if (url.pathname.startsWith('/admin/related-graph/build-index')) {
      const runId = url.searchParams.get('runId');
      return handleRelatedGraphBuildIndex(env, runId, url.origin);
    }
    // Build-word-chunk endpoint: write per‑word graph files in batches defined by offset and limit (max 250).
    if (url.pathname.startsWith('/admin/related-graph/build-word-chunk')) {
      const runId = url.searchParams.get('runId');
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const limit = parseInt(url.searchParams.get('limit') || '250', 10);
      return handleRelatedGraphBuildWordChunk(env, runId, offset, limit);
    }
    // Legacy build endpoint: map to build-index for backwards compatibility.
    if (url.pathname.startsWith('/admin/related-graph/build')) {
      const runId = url.searchParams.get('runId');
      // Map legacy build to build-index to maintain existing integrations.
      return handleRelatedGraphBuildIndex(env, runId, url.origin);
    }
    // Related graph verify: verifies that the related graph artifacts exist and are consistent.
    if (url.pathname.startsWith('/admin/related-graph/verify')) {
      const runId = url.searchParams.get('runId');
      return handleRelatedGraphVerify(env, runId);
    }
    // Finalize export status: report run manifest details and existing final files.
    if (url.pathname.startsWith('/admin/finalize-export/status')) {
      const runId = url.searchParams.get('runId');
      return handleFinalizeExportStatus(env, runId);
    }
    // Finalize export verification: ensure all expected files exist and return counts.
    if (url.pathname.startsWith('/admin/finalize-export/verify')) {
      const runId = url.searchParams.get('runId');
      return handleFinalizeExportVerify(env, runId);
    }
    // Build core data (manifest, summary, core, home and basic SEO).  This reuses the
    // existing finalize‑export‑core handler and is idempotent.
    if (url.pathname.startsWith('/admin/finalize-export/build-core')) {
      const runId = url.searchParams.get('runId');
      return handleFinalizeExportBuildCore(env, runId, url.origin);
    }
    // Build manifest file; this maps to build-core for now (idempotent).
    if (url.pathname.startsWith('/admin/finalize-export/build-manifest')) {
      const runId = url.searchParams.get('runId');
      return handleFinalizeExportBuildCore(env, runId, url.origin);
    }
    // Build summary file; this maps to build-core for now (idempotent).
    if (url.pathname.startsWith('/admin/finalize-export/build-summary')) {
      const runId = url.searchParams.get('runId');
      return handleFinalizeExportBuildCore(env, runId, url.origin);
    }
    // Build home dataset; this maps to build-core for now (idempotent).
    if (url.pathname.startsWith('/admin/finalize-export/build-home')) {
      const runId = url.searchParams.get('runId');
      return handleFinalizeExportBuildCore(env, runId, url.origin);
    }
    // Build SEO index and sitemaps.
    if (url.pathname.startsWith('/admin/finalize-export/build-seo-index')) {
      const runId = url.searchParams.get('runId');
      return handleFinalizeExportBuildSeoIndex(env, runId, url.origin);
    }
    // Build hub files (per‑hub JSON) from the core dataset.
    if (url.pathname.startsWith('/admin/finalize-export/build-hubs')) {
      const runId = url.searchParams.get('runId');
      return handleFinalizeExportBuildHubs(env, runId, url.origin);
    }
    // Build sitemaps only.
    if (url.pathname.startsWith('/admin/finalize-export/build-sitemaps')) {
      const runId = url.searchParams.get('runId');
      return handleFinalizeExportBuildSitemaps(env, runId, url.origin);
    }
    // Finalise export (legacy – may timeout on large runs).  Match exact path so
    // that more specific routes (e.g. /finalize-export-core) are not captured.
    if (url.pathname === '/admin/finalize-export') {
      const runId = url.searchParams.get('runId');
      return handleFinalizeExport(env, runId, url.origin);
    }
    // Finalise export core only (no per-word copy)
    if (url.pathname.startsWith('/admin/finalize-export-core')) {
      const runId = url.searchParams.get('runId');
      return handleFinalizeExportCore(env, runId, url.origin);
    }
    // Finalise per-word files for a specific chunk
    if (url.pathname.startsWith('/admin/finalize-word-files-chunk')) {
      const runId = url.searchParams.get('runId');
      const chunkOffset = parseInt(url.searchParams.get('chunkOffset') || '0', 10);
      return handleFinalizeWordFilesChunk(env, runId, chunkOffset, url.origin);
    }
    return jsonResponse({ ok: false, error: 'Not found' }, 404);
  },
};

// ============================================================================
// Endpoint handlers
// ============================================================================

async function handleDebugFetch(env, limit, offset) {
  if (!env.WEBFLOW_API_TOKEN || !env.WEBFLOW_COLLECTION_ID) {
    return jsonResponse({ ok: false, error: 'Missing WEBFLOW_API_TOKEN or WEBFLOW_COLLECTION_ID' }, 500);
  }
  const tests = [];
  const v2Live   = await fetchCmsDataRaw(env, limit, offset, 'v2_live');
  tests.push(buildDiagnostics(v2Live,   'v2_live'));
  const v2Staged = await fetchCmsDataRaw(env, limit, offset, 'v2_staged');
  tests.push(buildDiagnostics(v2Staged, 'v2_staged'));
  const v1Legacy = await fetchCmsDataRaw(env, limit, offset, 'v1_legacy');
  tests.push(buildDiagnostics(v1Legacy, 'v1_legacy');
  return jsonResponse({ ok: true, tests });
}

// Diagnostics for field structure
async function handleDebugWebflowFields(env, limit, offset, spread) {
  if (!env.WEBFLOW_API_TOKEN || !env.WEBFLOW_COLLECTION_ID) {
    return jsonResponse({ ok: false, error: 'Missing WEBFLOW_API_TOKEN or WEBFLOW_COLLECTION_ID' }, 500);
  }
  const items = spread
    ? await fetchCmsItemsSpread(env, limit)
    : await fetchCmsItemsPaged(env, limit, offset);
  const formatted = items.map(item => {
    const fields = item.fieldData || item.fields || item;
    const fieldKeys = Object.keys(fields);
    const nonEmptyFieldData = {};
    for (const k of fieldKeys) {
      const v = fields[k];
      if (v === null || v === undefined) continue;
      if (typeof v === 'string' && v.trim() === '') continue;
      if (Array.isArray(v) && v.length === 0) continue;
      nonEmptyFieldData[k] = summariseField(v);
    }
    return {
      id:   item._id || item.id,
      slug: fields.slug,
      name: fields.name,
      topLevelKeys:  Object.keys(item),
      fieldDataKeys: fieldKeys,
      nonEmptyFieldData,
    };
  });
  return jsonResponse({
    ok: true,
    collectionId: env.WEBFLOW_COLLECTION_ID,
    sampleCount: formatted.length,
    items: formatted,
  });
}
// Validation export handler: fetch small dataset, normalise and write to staging
async function handleTestExport(env, limit, offset, origin) {
  if (!env.WEBFLOW_API_TOKEN || !env.WEBFLOW_COLLECTION_ID) {
    return jsonResponse({ ok: false, error: 'Missing WEBFLOW_API_TOKEN or WEBFLOW_COLLECTION_ID' }, 500);
  }
  if (!env.QUIZ_PACK) {
    return jsonResponse({ ok: false, error: 'Missing R2 binding (QUIZ_PACK)' }, 500);
  }
  // Fetch up to limit items via pagination
  const items = await fetchCmsItemsPaged(env, limit, offset);
  // If no items returned, return diagnostics without writing
  if (items.length === 0) {
    const diag = await fetchCmsDataRaw(env, Math.min(limit, 1), offset, 'v2_live');
    return jsonResponse({
      ok: false,
      stage: 'webflow_fetch',
      error: 'webflow_items_empty',
      message: 'Webflow returned zero CMS items. This is not a valid export.',
      diagnostics: {
        fetchUrl: diag.url,
        httpStatus:  diag.status,
        responseKeys: diag.data ? Object.keys(diag.data) : [],
        msg:      diag.data && diag.data.msg,
        code:     diag.data && diag.data.code,
        name:     diag.data && diag.data.name,
        path:     diag.data && diag.data.path,
        err:      diag.data && diag.data.err,
      },
    }, 200);
  }
  // Normalise and filter valid quiz words
  const normalised = items.map(item => normaliseCmsItem(item));
  const valid = normalised.filter(w => w && w.slug && w.word);
  if (valid.length === 0) {
    // Normalisation returned no valid words; likely slug/name mapping issue
    return jsonResponse({
      ok: false,
      stage: 'normalisation',
      error: 'no_valid_quiz_words',
      message: 'Normalisation produced zero valid quiz words. Check field mappings.',
    }, 200);
  }
  // Write per-word and per-hub files into staging
  const manifest   = { version: `test-${new Date().toISOString()}`, source: 'webflow_cms_test', mode: 'test', count: valid.length };
  const summary    = { ok: true, totalItems: items.length, validQuizWords: valid.length };
  const hubMap     = {};
  valid.forEach(w => {
    if (!hubMap[w.hub]) hubMap[w.hub] = [];
    hubMap[w.hub].push(w);
  });
  // Write core and summary
  await env.QUIZ_PACK.put(`staging/quiz-pack/manifest.json`, JSON.stringify(manifest, null, 2));
  await env.QUIZ_PACK.put(`staging/quiz-pack/core-v1.json`, JSON.stringify(valid, null, 2));
  await env.QUIZ_PACK.put(`staging/quiz-pack/summary.json`, JSON.stringify(summary, null, 2));
  await env.QUIZ_PACK.put(`staging/quiz-pack/home-v1.json`, JSON.stringify(valid, null, 2));
  // Write per-word JSON files and per-hub JSON files
  let wordsWritten = 0;
  let hubsWritten  = 0;
  for (const w of valid) {
    await env.QUIZ_PACK.put(`staging/quiz-pack/words/${w.slug}.json`, JSON.stringify(w, null, 2));
    wordsWritten++;
  }
  for (const hubId of Object.keys(hubMap)) {
    await env.QUIZ_PACK.put(`staging/quiz-pack/hubs/${hubId}.json`, JSON.stringify(hubMap[hubId], null, 2));
    hubsWritten++;
  }
  // Write basic SEO index file
  await env.QUIZ_PACK.put(`staging/seo/word-index.json`, JSON.stringify(valid.map(wordIndex), null, 2));
  return jsonResponse({
    ok: true,
    written: { core: true, summary: true, home: true, wordCount: wordsWritten, hubCount: hubsWritten },
    testUrls: {
      manifest:        `${origin}/staging/quiz-pack/manifest.json`,
      core:            `${origin}/staging/quiz-pack/core-v1.json`,
      summary:         `${origin}/staging/quiz-pack/summary.json`,
      home:            `${origin}/staging/quiz-pack/home-v1.json`,
      wordIndex:       `${origin}/staging/seo/word-index.json`,
      word: valid.length > 0 ? `${origin}/staging/quiz-pack/words/${valid[0].slug}.json` : undefined,
      hub:  valid.length > 0 ? `${origin}/staging/quiz-pack/hubs/${valid[0].hub}.json`  : undefined,
    },
  });
}

// Chunked export handler: fetches a block of CMS items, normalises and writes to R2
async function handleExportChunk(env, runId, offset, limit) {
  if (!runId || runId.trim() === '') {
    return jsonResponse({ ok: false, error: 'runId parameter is required' }, 400);
  }
  if (!env.QUIZ_PACK) {
    return jsonResponse({ ok: false, error: 'Missing R2 binding (QUIZ_PACK)' }, 500);
  }
  const maxLimit = 1000;
  const safeLimit = Math.min(limit, maxLimit);
  // Fetch items via pagination
  const items = await fetchCmsItemsPaged(env, safeLimit, offset);
  // Normalise words
  const normalised = items.map(item => normaliseCmsItem(item));
  const valid = normalised.filter(w => w && w.slug && w.word);
  // Write chunk file
  const chunkKey = `staging/runs/${runId}/chunks/chunk-offset-${offset}.json`;
  await env.QUIZ_PACK.put(chunkKey, JSON.stringify(valid, null, 2));
  // Build manifest for this chunk
  const manifest = {
    runId,
    offset,
    limit: safeLimit,
    fetched: items.length,
    normalized: normalised.length,
    validQuizWords: valid.length,
    missingImage:       valid.filter(w => !w.image).length,
    missingDefinition:  valid.filter(w => !w.definition).length,
    missingExample:     valid.filter(w => !w.example).length,
    missingHub:         valid.filter(w => !w.hub).length,
    synonymsPresent:    valid.filter(w => w.synonyms && w.synonyms.length > 0).length,
    antonymsPresent:    valid.filter(w => w.antonyms && w.antonyms.length > 0).length,
    relatedPresent:     valid.filter(w => w.related && w.related.length > 0).length,
    confusablesPresent: valid.filter(w => w.confusables && w.confusables.length > 0).length,
  };
  const manifestKey = `staging/runs/${runId}/chunk-manifests/chunk-offset-${offset}.json`;
  await env.QUIZ_PACK.put(manifestKey, JSON.stringify(manifest, null, 2));
  // Also write per-word files into run-specific prefix
  for (const w of valid) {
    const key = `staging/runs/${runId}/words/${w.slug}.json`;
    await env.QUIZ_PACK.put(key, JSON.stringify(w, null, 2));
  }
  return jsonResponse({ ok: true, runId, offset, limit: safeLimit, fetched: items.length, validQuizWords: valid.length });
}

// Finalise export (legacy) – may timeout on large runs.  Use finalize-export-core + finalize-word-files-chunk for large datasets.
async function handleFinalizeExport(env, runId, origin) {
  if (!runId || runId.trim() === '') {
    return jsonResponse({ ok: false, error: 'runId parameter is required' }, 400);
  }
  if (!env.QUIZ_PACK) {
    return jsonResponse({ ok: false, error: 'Missing R2 binding (QUIZ_PACK)' }, 500);
  }
  // List chunk manifest files for this run
  const manifestPrefix = `staging/runs/${runId}/chunk-manifests/`;
  let objects = [];
  let cursor;
  do {
    const listing = await env.QUIZ_PACK.list({ prefix: manifestPrefix, cursor });
    objects = objects.concat(listing.objects || []);
    cursor = listing.cursor;
  } while (cursor);
  if (objects.length === 0) {
    return jsonResponse({ ok: false, error: `No chunk manifests found for runId ${runId}` }, 400);
  }
  // Sort chunk manifests by offset extracted from filename
  const manifestEntries = [];
  for (const obj of objects) {
    const key = obj.key;
    const m = key.match(/chunk-offset-(\d+)\.json$/);
    const offset = m ? parseInt(m[1], 10) : 0;
    const val = await env.QUIZ_PACK.get(key);
    const manifestJson = val ? await val.text() : '{}';
    const manifest = JSON.parse(manifestJson);
    manifestEntries.push({ offset, manifest });
  }
  manifestEntries.sort((a, b) => a.offset - b.offset);
  // Aggregate all words and metrics
  const seen = new Map();
  let totalFetched       = 0;
  let totalNormalized    = 0;
  let totalValid         = 0;
  let missingImage       = 0;
  let missingDefinition  = 0;
  let missingExample     = 0;
  let missingHub         = 0;
  let synonymsPresent    = 0;
  let antonymsPresent    = 0;
  let relatedPresent     = 0;
  let confusablesPresent = 0;
  const hubsSet = new Set();
  for (const entry of manifestEntries) {
    const offset = entry.offset;
    const chunkKey = `staging/runs/${runId}/chunks/chunk-offset-${offset}.json`;
    const obj = await env.QUIZ_PACK.get(chunkKey);
    if (!obj) continue;
    const text = await obj.text();
    let words;
    try {
      words = JSON.parse(text);
    } catch (_) {
      words = [];
    }
    const man = entry.manifest;
    totalFetched       += man.fetched;
    totalNormalized    += man.normalized;
    totalValid         += man.validQuizWords;
    missingImage       += man.missingImage;
    missingDefinition  += man.missingDefinition;
    missingExample     += man.missingExample;
    missingHub         += man.missingHub;
    synonymsPresent    += man.synonymsPresent;
    antonymsPresent    += man.antonymsPresent;
    relatedPresent     += man.relatedPresent;
    confusablesPresent += man.confusablesPresent;
    for (const w of words) {
      if (!seen.has(w.slug)) {
        seen.set(w.slug, w);
        if (w.hub) hubsSet.add(w.hub);
      }
    }
  }
  // Convert to array and sort
  const allWords = Array.from(seen.values());
  allWords.sort((a, b) => a.slug.localeCompare(b.slug));
  // Build hub map
  const hubMapFinal = {};
  allWords.forEach(w => {
    if (!hubMapFinal[w.hub]) hubMapFinal[w.hub] = [];
    hubMapFinal[w.hub].push(w);
  });
  // Aggregate hub assignment counts
  let explicitHubCount   = 0;
  let fallbackHubCount   = 0;
  let uncategorizedCount = 0;
  for (const w of allWords) {
    if (!w.hub || w.hub === 'uncategorized') {
      uncategorizedCount++;
    } else if (w.hubs && w.hubs.includes(w.hub)) {
      explicitHubCount++;
    } else {
      fallbackHubCount++;
    }
  }
  // Build manifest and summary
  const finalPrefix = 'staging';
  const manifestFinal = {
    version: `full-${new Date().toISOString()}`,
    source:  'webflow_cms_live_items',
    mode:    `full_${runId}`,
    totalCmsItems: totalFetched,
    normalized:    totalNormalized,
    wordCount:     allWords.length,
    hubCount:      hubsSet.size,
    eligibleImageToWord:      allWords.filter(w => w.image).length,
    eligibleDefinitionToWord: allWords.filter(w => w.definition).length,
    eligibleCloze:    0,
    relatedEdges:     0,
    relationMode:     'same_hub_fallback',
    updatedAt:        new Date().toISOString(),
    explicitHubCount,
    fallbackHubCount,
    uncategorizedCount,
    hubAssignmentMode: 'cms_hub_with_topic_fallback',
  };
    const summaryFinal = {
    ok: true,
    totalCmsItems: totalFetched,
    normalized: totalNormalized,
    validQuizWords: allWords.length,
    missingImage,
    missingDefinition,
    missingExample,
    missingHub,
    synonymsPresent,
    antonymsPresent,
    relatedPresent,
    confusablesPresent,
    hubCount: hubsSet.size,
    explicitHubCount,
    fallbackHubCount,
    uncategorizedCount,
    hubAssignmentMode: 'cms_hub_with_topic_fallback',
  };
  // Write final files (core/home, manifest/summary, SEO, hubs)
  await env.QUIZ_PACK.put(`${finalPrefix}/quiz-pack/core-v1.json`, JSON.stringify(allWords, null, 2));
  await env.QUIZ_PACK.put(`${finalPrefix}/quiz-pack/manifest.json`, JSON.stringify(manifestFinal, null, 2));
  await env.QUIZ_PACK.put(`${finalPrefix}/quiz-pack/summary.json`, JSON.stringify(summaryFinal, null, 2));
  await env.QUIZ_PACK.put(`${finalPrefix}/quiz-pack/home-v1.json`, JSON.stringify(allWords, null, 2));
  // SEO files
  await env.QUIZ_PACK.put(`${finalPrefix}/seo/word-index.json`, JSON.stringify(allWords.map(wordIndex), null, 2));
  await env.QUIZ_PACK.put(`${finalPrefix}/seo/related-edges.json`, JSON.stringify([]));
  await env.QUIZ_PACK.put(`${finalPrefix}/seo/missing-related-report.json`, JSON.stringify({ generatedAt: new Date().toISOString(), unmatchedCount: 0, rows: [] }));
  // Write per-hub files
  for (const hubId of Object.keys(hubMapFinal)) {
    await env.QUIZ_PACK.put(`${finalPrefix}/quiz-pack/hubs/${hubId}.json`, JSON.stringify(hubMapFinal[hubId], null, 2));
  }
  // Build test URLs
  const sample = allWords[0];
  const testUrlsFinal = {
    manifest:        `${origin}/${finalPrefix}/quiz-pack/manifest.json`,
    core:            `${origin}/${finalPrefix}/quiz-pack/core-v1.json`,
    summary:         `${origin}/${finalPrefix}/quiz-pack/summary.json`,
    home:            `${origin}/${finalPrefix}/quiz-pack/home-v1.json`,
    wordIndex:       `${origin}/${finalPrefix}/seo/word-index.json`,
    missingRelated:  `${origin}/${finalPrefix}/seo/missing-related-report.json`,
    word: sample ?  `${origin}/${finalPrefix}/quiz-pack/words/${sample.slug}.json` : undefined,
    hub:  sample ?  `${origin}/${finalPrefix}/quiz-pack/hubs/${sample.hub}.json`  : undefined,
  };
  // total files written: core, home, manifest, summary, seo files + hub files
  const totalFilesWritten = 4 + 3 + Object.keys(hubMapFinal).length;
  return jsonResponse({
    ok: true,
    runId,
    fetched: totalFetched,
    normalized: totalNormalized,
    validQuizWords: allWords.length,
    missingImage,
    missingDefinition,
    missingExample,
    missingHub,
    synonymsPresent,
    antonymsPresent,
    relatedPresent,
    confusablesPresent,
    hubCount: hubsSet.size,
    explicitHubCount,
    fallbackHubCount,
    uncategorizedCount,
    hubAssignmentMode: 'cms_hub_with_topic_fallback',
    filesWritten: totalFilesWritten,
    testUrls: testUrlsFinal,
  });
}

// Finalise per-word files for a specific chunk. This copies each word in the
// specified chunk from the run-specific words folder into the final
// quiz-pack/words prefix. Does not modify hub or core datasets.
async function handleFinalizeWordFilesChunk(env, runId, chunkOffset, origin) {
  if (!runId || runId.trim() === '') {
    return jsonResponse({ ok: false, error: 'runId parameter is required' }, 400);
  }
  if (!env.QUIZ_PACK) {
    return jsonResponse({ ok: false, error: 'Missing R2 binding (QUIZ_PACK)' }, 500);
  }
  // Fetch the chunk file for the given offset
  const chunkKey = `staging/runs/${runId}/chunks/chunk-offset-${chunkOffset}.json`;
  const obj = await env.QUIZ_PACK.get(chunkKey);
  if (!obj) {
    return jsonResponse({ ok: false, error: `Chunk file not found for runId ${runId} and offset ${chunkOffset}` }, 400);
  }
  const text = await obj.text();
  let words;
  try {
    words = JSON.parse(text);
  } catch (_) {
    words = [];
  }
  if (!Array.isArray(words) || words.length === 0) {
    return jsonResponse({ ok: false, error: `No words found in chunk for runId ${runId} and offset ${chunkOffset}` }, 200);
  }
  // Copy each word to final path
  let filesWritten = 0;
  for (const w of words) {
    if (!w || !w.slug) continue;
    const finalKey = `staging/quiz-pack/words/${w.slug}.json`;
    await env.QUIZ_PACK.put(finalKey, JSON.stringify(w, null, 2));
    filesWritten++;
  }
  return jsonResponse({
    ok: true,
    runId,
    chunkOffset,
    wordCount: words.length,
    filesWritten,
    firstSlug: words[0].slug,
    lastSlug:  words[words.length - 1].slug,
    message: 'Per-word files written to final quiz-pack/words prefix',
  });
}

// Serve static staging files from R2 in a read‑only manner.
async function handleServeStaging(env, pathname) {
  const key = pathname.replace(/^\//, '');
  if (!env.QUIZ_PACK) {
    return jsonResponse({ ok: false, error: 'Missing R2 binding (QUIZ_PACK)' }, 500);
  }
  const obj = await env.QUIZ_PACK.get(key);
  if (!obj) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  // Infer content type
  const ext = (key.split('.').pop() || '').toLowerCase();
  let contentType = 'application/octet-stream';
  if (ext === 'json') contentType = 'application/json';
  else if (ext === 'xml') contentType = 'application/xml';
  else if (ext === 'txt') contentType = 'text/plain';
  else if (ext === 'html') contentType = 'text/html';
  else if (ext === 'md' || ext === 'markdown') contentType = 'text/markdown';
  // Return as text when possible
  if (contentType.startsWith('application/json') || contentType.startsWith('application/xml') || contentType.startsWith('text/')) {
    const text = await obj.text();
    return new Response(text, {
      status: 200,
      headers: {
        'content-type': contentType,
        'cache-control': 'public, max-age=60, s-maxage=60',
      },
    });
  } else {
    const arr = await obj.arrayBuffer();
    return new Response(arr, {
      status: 200,
      headers: {
        'content-type': contentType,
        'cache-control': 'public, max-age=60, s-maxage=60',
      },
    });
  }
}

// Helper: read and parse the core words file if it exists.
async function readCoreWords(env) {
  if (!env.QUIZ_PACK) return [];
  const key = 'staging/quiz-pack/core-v1.json';
  const obj = await env.QUIZ_PACK.get(key);
  if (!obj) return [];
  try {
    const text = await obj.text();
    const words = JSON.parse(text);
    return Array.isArray(words) ? words : [];
  } catch (_) {
    return [];
  }
}

// Compute basic counts for a list of words: total words, unique hubs, words with images.
function computeCoreCounts(words) {
  const hubs = new Set();
  let images = 0;
  for (const w of words) {
    if (w && w.hub) hubs.add(w.hub);
    if (w && w.image) images++;
  }
  return {
    wordCount: words.length,
    hubCount: hubs.size,
    imageCount: images,
  };
}

// List chunk manifest entries for a given run and return offsets and manifest data.
async function listRunChunkManifests(env, runId) {
  const manifests = [];
  const prefix = `staging/runs/${runId}/chunk-manifests/`;
  if (!env.QUIZ_PACK) return manifests;
  let cursor;
  do {
    const listing = await env.QUIZ_PACK.list({ prefix, cursor });
    for (const obj of listing.objects || []) {
      const m = obj.key.match(/chunk-offset-(\d+)\.json$/);
      const offset = m ? parseInt(m[1], 10) : 0;
      // Read manifest file
      const mf = await env.QUIZ_PACK.get(obj.key);
      const text = mf ? await mf.text() : '{}';
      let manifest;
      try {
        manifest = JSON.parse(text);
      } catch (_) {
        manifest = {};
      }
      manifests.push({ offset, manifest });
    }
    cursor = listing.cursor;
  } while (cursor);
  manifests.sort((a, b) => a.offset - b.offset);
  return manifests;
}
// Status endpoint: returns run manifest details and which final files exist.
async function handleFinalizeExportStatus(env, runId) {
  if (!runId || runId.trim() === '') {
    return jsonResponse({ ok: false, error: 'runId parameter is required' }, 400);
  }
  if (!env.QUIZ_PACK) {
    return jsonResponse({ ok: false, error: 'Missing R2 binding (QUIZ_PACK)' }, 500);
  }
  // List chunk manifests
  const manifests = await listRunChunkManifests(env, runId);
  const chunkOffsets = manifests.map(m => m.offset);
  // Determine next step based on existing files
  const coreObj = await env.QUIZ_PACK.get('staging/quiz-pack/core-v1.json');
  const slugObj = await env.QUIZ_PACK.get('staging/seo/slug-index.json');
  const hubsObj = await env.QUIZ_PACK.get('staging/seo/hubs-v1.json');
  const wordsSitemapObj = await env.QUIZ_PACK.get('staging/seo/words-sitemap.xml');
  let nextStep = null;
  if (chunkOffsets.length === 0) {
    nextStep = 'export-chunks';
  } else if (!coreObj) {
    nextStep = 'build-core';
  } else if (!slugObj || !hubsObj || !wordsSitemapObj) {
    nextStep = 'build-seo-index';
  } else {
    nextStep = 'verify';
  }
  // Build counts summary from manifests
  let totalFetched = 0;
  let totalNormalized = 0;
  let totalValid = 0;
  for (const m of manifests) {
    const man = m.manifest || {};
    totalFetched += man.fetched || 0;
    totalNormalized += man.normalized || 0;
    totalValid += man.validQuizWords || 0;
  }
  return jsonResponse({
    ok: true,
    runId,
    step: 'status',
    counts: {
      chunks: chunkOffsets.length,
      totalFetched,
      totalNormalized,
      totalValidWords: totalValid,
    },
    createdFiles: [],
    errors: [],
    nextStep,
    chunkOffsets,
  });
}

// Verify endpoint: checks for existence of all expected staging files and returns counts.
async function handleFinalizeExportVerify(env, runId) {
  if (!runId || runId.trim() === '') {
    return jsonResponse({ ok: false, error: 'runId parameter is required' }, 400);
  }
  if (!env.QUIZ_PACK) {
    return jsonResponse({ ok: false, error: 'Missing R2 binding (QUIZ_PACK)' }, 500);
  }
  // Expected file keys
  const expected = [
    'staging/quiz-pack/core-v1.json',
    'staging/quiz-pack/manifest.json',
    'staging/quiz-pack/summary.json',
    'staging/quiz-pack/home-v1.json',
    'staging/seo/word-index.json',
    'staging/seo/slug-index.json',
    'staging/seo/hubs-v1.json',
    'staging/seo/image-index.json',
    'staging/seo/sitemap-index.xml',
    'staging/seo/words-sitemap.xml',
    'staging/seo/images-sitemap.xml',
  ];
  const missing = [];
  for (const key of expected) {
    const obj = await env.QUIZ_PACK.get(key);
    if (!obj) missing.push(key);
  }
  // Compute counts if core exists
  let counts = {};
  const words = await readCoreWords(env);
  if (words.length > 0) {
    counts = computeCoreCounts(words);
  }
  return jsonResponse({
    ok: missing.length === 0,
    runId,
    step: 'verify',
    createdFiles: [],
    counts,
    errors: missing,
    nextStep: missing.length === 0 ? null : 'build-core',
  });
}

// Build core dataset (manifest, summary, core and home files).  This calls the
// existing handleFinalizeExportCore function and returns a simplified summary.
async function handleFinalizeExportBuildCore(env, runId, origin) {
  if (!runId || runId.trim() === '') {
    return jsonResponse({ ok: false, error: 'runId parameter is required' }, 400);
  }
  // Delegate to existing core handler
  const resp = await handleFinalizeExportCore(env, runId, origin);
  // Attempt to parse counts from response
  let data;
  try {
    data = await resp.json();
  } catch (_) {
    data = null;
  }
  const createdFiles = [
    'staging/quiz-pack/core-v1.json',
    'staging/quiz-pack/manifest.json',
    'staging/quiz-pack/summary.json',
    'staging/quiz-pack/home-v1.json',
    'staging/seo/word-index.json',
    'staging/seo/related-edges.json',
    'staging/seo/missing-related-report.json',
  ];
  const nextStep = 'build-seo-index';
  return jsonResponse({
    ok: data && data.ok,
    runId,
    step: 'build-core',
    createdFiles,
    counts: {
      fetched: data ? data.fetched : undefined,
      normalized: data ? data.normalized : undefined,
      validQuizWords: data ? data.validQuizWords : undefined,
    },
    errors: data && data.ok ? [] : [data && data.error],
    nextStep,
    testUrls: data && data.testUrls,
  });
}

// Build SEO index, hubs and sitemaps.
async function handleFinalizeExportBuildSeoIndex(env, runId, origin) {
  if (!runId || runId.trim() === '') {
    return jsonResponse({ ok: false, error: 'runId parameter is required' }, 400);
  }
  if (!env.QUIZ_PACK) {
    return jsonResponse({ ok: false, error: 'Missing R2 binding (QUIZ_PACK)' }, 500);
  }
  const words = await readCoreWords(env);
  if (!words || words.length === 0) {
    return jsonResponse({ ok: false, error: 'core dataset not found' }, 400);
  }
  // Build slug index
  const slugIndex = words.map(w => ({
    slug: w.slug,
    hub: w.hub,
    hubs: w.hubs,
  }));
  // Build hub map
  const hubMap = {};
  for (const w of words) {
    const hubId = w.hub || 'uncategorized';
    if (!hubMap[hubId]) hubMap[hubId] = [];
    hubMap[hubId].push(w.slug);
  }
  // Convert to hubs list
  const hubsList = [];
  for (const hubId of Object.keys(hubMap)) {
    hubsList.push({ hub: hubId, slugs: hubMap[hubId], count: hubMap[hubId].length });
  }
  // Build image index
  const imageIndex = [];
  for (const w of words) {
    if (w.image) {
      imageIndex.push({ slug: w.slug, image: w.image });
    }
  }
  // Build words sitemap
  function escapeXml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\\"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
  const wordUrls = words.map(w => {
    const loc = `${origin}/quiz/${encodeURIComponent(w.slug)}`;
    return `  <url><loc>${escapeXml(loc)}</loc></url>`;
  });
  const wordsSitemapXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...wordUrls,
    '</urlset>',
  ].join('\n');
  // Build images sitemap
  const imageUrls = imageIndex.map(w => {
    const loc = `${origin}/quiz/${encodeURIComponent(w.slug)}`;
    const img = escapeXml(w.image);
    return `  <url><loc>${escapeXml(loc)}</loc><image:image xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><image:loc>${img}</image:loc></image:image></url>`;
  });
  const imagesSitemapXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    ...imageUrls,
    '</urlset>',
  ].join('\n');
  // Build sitemap index referencing both sitemaps
  const sitemapIndexXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <sitemap><loc>${origin}/staging/seo/words-sitemap.xml</loc></sitemap>`,
    `  <sitemap><loc>${origin}/staging/seo/images-sitemap.xml</loc></sitemap>`,
    '</sitemapindex>',
  ].join('\n');
    // Write files
  await env.QUIZ_PACK.put('staging/seo/slug-index.json', JSON.stringify(slugIndex, null, 2));
  await env.QUIZ_PACK.put('staging/seo/hubs-v1.json', JSON.stringify(hubsList, null, 2));
  await env.QUIZ_PACK.put('staging/seo/image-index.json', JSON.stringify(imageIndex, null, 2));
  await env.QUIZ_PACK.put('staging/seo/words-sitemap.xml', wordsSitemapXml);
  await env.QUIZ_PACK.put('staging/seo/images-sitemap.xml', imagesSitemapXml);
  await env.QUIZ_PACK.put('staging/seo/sitemap-index.xml', sitemapIndexXml);
  const createdFiles = [
    'staging/seo/slug-index.json',
    'staging/seo/hubs-v1.json',
    'staging/seo/image-index.json',
    'staging/seo/words-sitemap.xml',
    'staging/seo/images-sitemap.xml',
    'staging/seo/sitemap-index.xml',
  ];
  return jsonResponse({
    ok: true,
    runId,
    step: 'build-seo-index',
    createdFiles,
    counts: {
      slugs: slugIndex.length,
      hubs: hubsList.length,
      images: imageIndex.length,
    },
    errors: [],
    nextStep: 'verify',
  });
}

// Build hub JSON files only.
async function handleFinalizeExportBuildHubs(env, runId, origin) {
  if (!runId || runId.trim() === '') {
    return jsonResponse({ ok: false, error: 'runId parameter is required' }, 400);
  }
  if (!env.QUIZ_PACK) {
    return jsonResponse({ ok: false, error: 'Missing R2 binding (QUIZ_PACK)' }, 500);
  }
  const words = await readCoreWords(env);
  if (!words || words.length === 0) {
    return jsonResponse({ ok: false, error: 'core dataset not found' }, 400);
  }
  const hubMap = {};
  for (const w of words) {
    const hubId = w.hub || 'uncategorized';
    if (!hubMap[hubId]) hubMap[hubId] = [];
    hubMap[hubId].push(w);
  }
  const createdFiles = [];
  for (const hubId of Object.keys(hubMap)) {
    const key = `staging/quiz-pack/hubs/${hubId}.json`;
    await env.QUIZ_PACK.put(key, JSON.stringify(hubMap[hubId], null, 2));
    createdFiles.push(key);
  }
  return jsonResponse({
    ok: true,
    runId,
    step: 'build-hubs',
    createdFiles,
    counts: { hubs: Object.keys(hubMap).length },
    errors: [],
    nextStep: 'verify',
  });
}

// Build only the sitemap XML files using the existing slug and image indexes.
async function handleFinalizeExportBuildSitemaps(env, runId, origin) {
  if (!runId || runId.trim() === '') {
    return jsonResponse({ ok: false, error: 'runId parameter is required' }, 400);
  }
  if (!env.QUIZ_PACK) {
    return jsonResponse({ ok: false, error: 'Missing R2 binding (QUIZ_PACK)' }, 500);
  }
  // Read slug and image indexes
  const slugObj = await env.QUIZ_PACK.get('staging/seo/slug-index.json');
  const imgObj  = await env.QUIZ_PACK.get('staging/seo/image-index.json');
  if (!slugObj || !imgObj) {
    return jsonResponse({ ok: false, error: 'slug-index or image-index missing' }, 400);
  }
  let slugs, images;
  try {
    slugs = JSON.parse(await slugObj.text());
  } catch (_) {
    slugs = [];
  }
  try {
    images = JSON.parse(await imgObj.text());
  } catch (_) {
    images = [];
  }
  function escapeXml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\\"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
  const wordUrls = slugs.map(item => {
    const loc = `${origin}/quiz/${encodeURIComponent(item.slug)}`;
    return `  <url><loc>${escapeXml(loc)}</loc></url>`;
  });
  const wordsSitemapXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...wordUrls,
    '</urlset>',
  ].join('\n');
  const imageUrls = images.map(item => {
    const loc = `${origin}/quiz/${encodeURIComponent(item.slug)}`;
    const img = escapeXml(item.image);
    return `  <url><loc>${escapeXml(loc)}</loc><image:image xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><image:loc>${img}</image:loc></image:image></url>`;
  });
  const imagesSitemapXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    ...imageUrls,
    '</urlset>',
  ].join('\n');
  const sitemapIndexXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <sitemap><loc>${origin}/staging/seo/words-sitemap.xml</loc></sitemap>`,
    `  <sitemap><loc>${origin}/staging/seo/images-sitemap.xml</loc></sitemap>`,
    '</sitemapindex>',
  ].join('\n');
  // Write sitemaps
  await env.QUIZ_PACK.put('staging/seo/words-sitemap.xml', wordsSitemapXml);
  await env.QUIZ_PACK.put('staging/seo/images-sitemap.xml', imagesSitemapXml);
  await env.QUIZ_PACK.put('staging/seo/sitemap-index.xml', sitemapIndexXml);
  return jsonResponse({
    ok: true,
    runId,
    step: 'build-sitemaps',
    createdFiles: [
      'staging/seo/words-sitemap.xml',
      'staging/seo/images-sitemap.xml',
      'staging/seo/sitemap-index.xml',
    ],
    counts: {
      words: slugs.length,
      images: images.length,
    },
    errors: [],
    nextStep: 'verify',
  });
}

// ========================================================================
// Export integrity audit helpers and endpoints (Session 2)
// ========================================================================

// Helper: read JSON object from R2 if exists; returns parsed JSON or null.
async function r2GetJson(env, key) {
  if (!env.QUIZ_PACK) return null;
  const obj = await env.QUIZ_PACK.get(key);
  if (!obj) return null;
  try {
    const text = await obj.text();
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// Compute export integrity statistics from core dataset.
function computeExportIntegrity(words) {
  const stats = {
    wordCount: 0,
    hubCount: 0,
    imageCount: 0,
    duplicateSlugs: [],
    duplicateWords: [],
    missingImage: [],
    missingDefinition: [],
    missingExample: [],
    missingHub: [],
    invalidUrl: [],
    weakHubAssignment: [],
    uncategorized: [],
    topHubs: [],
    smallHubs: [],
    classificationCounts: { index: 0, pilot: 0, noindex: 0 },
    indexList: [],
    pilotList: [],
    noindexList: [],
    hubMap: {},
  };
  if (!Array.isArray(words)) return stats;
  stats.wordCount = words.length;
  const slugMap = new Map();
  const wordMap = new Map();
  let imageCount = 0;
  const hubs = new Map();
  for (const w of words) {
    if (!w) continue;
    // slug duplicates
    if (w.slug) {
      if (slugMap.has(w.slug)) {
        slugMap.set(w.slug, slugMap.get(w.slug) + 1);
      } else {
        slugMap.set(w.slug, 1);
      }
    } else {
      stats.invalidUrl.push(w);
    }
    // word duplicates
    const wordKey = (w.word || '').toLowerCase();
    if (wordKey) {
      if (wordMap.has(wordKey)) {
        wordMap.set(wordKey, wordMap.get(wordKey) + 1);
      } else {
        wordMap.set(wordKey, 1);
      }
    }
    // image count & missing image
    if (w.image) {
      imageCount++;
    } else {
      stats.missingImage.push(w);
    }
    // missing definition
    if (!w.definition) stats.missingDefinition.push(w);
    // missing example
    if (!w.example) stats.missingExample.push(w);
    // missing hub
    if (!w.hub) {
      stats.missingHub.push(w);
    }
    // invalid slug pattern
    if (!w.slug || !/^[a-z0-9-]+$/.test(w.slug)) {
      stats.invalidUrl.push(w);
    }
    // weak hub assignment: if hubs list missing or does not include hub id
    if (!w.hubs || !Array.isArray(w.hubs) || w.hubs.length === 0 || (w.hub && !w.hubs.includes(w.hub))) {
      stats.weakHubAssignment.push(w);
    }
    // uncategorized
    if (!w.hub || w.hub === 'uncategorized') stats.uncategorized.push(w);
    // Build hub map
    const hubId = w.hub || 'uncategorized';
    if (!hubs.has(hubId)) hubs.set(hubId, 0);
    hubs.set(hubId, hubs.get(hubId) + 1);
    // classification
    const hasSlug  = !!w.slug;
    const hasWord  = !!w.word;
    const hasDef   = !!w.definition;
    const hasImg   = !!w.image;
    const hasHub   = !!w.hub;
    const slugValid = hasSlug && /^[a-z0-9-]+$/.test(w.slug);
    // Determine classification
    let cls = 'noindex';
    if (!hasSlug || !hasWord || !slugValid) {
      cls = 'noindex';
    } else if (hasDef && hasImg && hasHub && slugValid) {
      cls = 'index';
    } else {
      cls = 'pilot';
    }
    if (cls === 'index') {
      stats.classificationCounts.index++;
      stats.indexList.push(w);
    } else if (cls === 'pilot') {
      stats.classificationCounts.pilot++;
      stats.pilotList.push(w);
    } else {
      stats.classificationCounts.noindex++;
      stats.noindexList.push(w);
    }
  }
  stats.imageCount = imageCount;
  // Determine duplicates
  for (const [slug, count] of slugMap.entries()) {
    if (count > 1) {
      stats.duplicateSlugs.push({ slug, count });
    }
  }
  for (const [word, count] of wordMap.entries()) {
    if (count > 1) {
      stats.duplicateWords.push({ word, count });
    }
  }
  // Build hub maps and sort top hubs
  stats.hubCount = hubs.size;
  const hubArray = Array.from(hubs.entries()).map(([hubId, count]) => ({ hub: hubId, count }));
  hubArray.sort((a, b) => b.count - a.count);
  stats.topHubs = hubArray.slice(0, 10);
  // small hubs threshold: less than 5 words
  stats.smallHubs = hubArray.filter(h => h.count < 5);
  return stats;
}

// Generate markdown report from export integrity statistics.
function generateExportIntegrityMarkdown(runId, stats) {
  const lines = [];
  lines.push(`# Export Integrity Report`);
  lines.push('');
  lines.push(`**Run ID:** \`${runId}\``);
  lines.push(`**Generated At:** ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`## Overview`);
  lines.push(`- Total words: **${stats.wordCount}**`);
  lines.push(`- Total hubs: **${stats.hubCount}**`);
  lines.push(`- Images present: **${stats.imageCount}**`);
  lines.push(`- Hubs with few words (small hubs <5 words): **${stats.smallHubs.length}**`);
  lines.push('');
  lines.push(`## Missing or Invalid Fields`);
  lines.push(`- Missing images: **${stats.missingImage.length}**`);
  lines.push(`- Missing definitions: **${stats.missingDefinition.length}**`);
  lines.push(`- Missing examples: **${stats.missingExample.length}**`);
  lines.push(`- Missing hubs: **${stats.missingHub.length}**`);
  lines.push(`- Invalid slugs/URLs: **${stats.invalidUrl.length}**`);
  lines.push(`- Weak hub assignments: **${stats.weakHubAssignment.length}**`);
  lines.push(`- Uncategorized words: **${stats.uncategorized.length}**`);
  lines.push('');
  lines.push(`## Duplicates`);
  lines.push(`- Duplicate slugs: **${stats.duplicateSlugs.length}**`);
  if (stats.duplicateSlugs.length > 0) {
    lines.push(`  - ` + stats.duplicateSlugs.map(d => `\`${d.slug}\` (x${d.count})`).join(', '));
  }
  lines.push(`- Duplicate words: **${stats.duplicateWords.length}**`);
  if (stats.duplicateWords.length > 0) {
    lines.push(`  - ` + stats.duplicateWords.map(d => `\`${d.word}\` (x${d.count})`).join(', '));
  }
  lines.push('');
  lines.push(`## Classification`);
  lines.push(`- Index: **${stats.classificationCounts.index}**`);
  lines.push(`- Pilot: **${stats.classificationCounts.pilot}**`);
  lines.push(`- Noindex: **${stats.classificationCounts.noindex}**`);
  lines.push('');
  lines.push(`## Top Hubs by Word Count`);
  lines.push(stats.topHubs.map(h => `- ${h.hub}: ${h.count}`).join('\n'));
  lines.push('');
  if (stats.smallHubs.length > 0) {
    lines.push(`## Small Hubs (<5 words)`);
    lines.push(stats.smallHubs.map(h => `- ${h.hub}: ${h.count}`).join('\n'));
    lines.push('');
  }
  if (stats.missingImage.length > 0) {
    lines.push(`## Words Missing Images (First 10)`);
    const list = stats.missingImage.slice(0, 10).map(w => `- ${w.slug || w.word}`);
    lines.push(list.join('\n'));
    lines.push('');
  }
  return lines.join('\n');
}
