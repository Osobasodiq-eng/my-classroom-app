const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

// Anything readable becomes plain text; anything else (images, slide decks,
// unknown formats) is left ungrounded rather than guessed at. Extraction
// failures are swallowed and just result in an empty string — a single
// corrupt upload shouldn't break the study assistant for the whole course.
const MAX_CHARS = 200000; // hard safety cap per file, independent of the LLM context budget applied later

async function extractText(mimeType, filename, buffer) {
  try {
    const isPdf = mimeType === 'application/pdf' || /\.pdf$/i.test(filename || '');
    if (isPdf) {
      const result = await pdfParse(buffer);
      return (result.text || '').slice(0, MAX_CHARS);
    }
    const isDocx =
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      /\.docx$/i.test(filename || '');
    if (isDocx) {
      const result = await mammoth.extractRawText({ buffer });
      return (result.value || '').slice(0, MAX_CHARS);
    }
    if (mimeType && mimeType.startsWith('text/')) {
      return buffer.toString('utf8').slice(0, MAX_CHARS);
    }
  } catch (err) {
    console.error('Text extraction failed for', filename, '-', err.message);
  }
  return '';
}

module.exports = { extractText };
