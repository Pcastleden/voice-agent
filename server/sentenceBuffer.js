class SentenceBuffer {
  constructor(onSentence) {
    this.buffer = "";
    this.onSentence = onSentence;
    this.minWords = 5;

    this.abbreviations = new Set([
      "dr", "mr", "mrs", "ms", "prof", "sr", "jr",
      "vs", "etc", "inc", "ltd", "co",
      "st", "ave", "dept", "approx", "govt",
    ]);
  }

  add(text) {
    this.buffer += text;
    this._tryEmit();
  }

  _tryEmit() {
    // Match sentence-ending punctuation followed by whitespace
    const regex = /([.!?]+)\s+/g;
    let match;
    let lastEmitEnd = 0;

    while ((match = regex.exec(this.buffer)) !== null) {
      const candidateEnd = match.index + match[0].length;
      const sentence = this.buffer.substring(lastEmitEnd, candidateEnd).trim();

      // Skip if period is part of an abbreviation
      if (match[1] === "." && this._isAbbreviation(this.buffer, match.index)) {
        continue;
      }

      // Skip if too short
      const wordCount = sentence.split(/\s+/).length;
      if (wordCount < this.minWords) {
        continue;
      }

      this.onSentence(sentence);
      lastEmitEnd = candidateEnd;
    }

    if (lastEmitEnd > 0) {
      this.buffer = this.buffer.substring(lastEmitEnd);
    }
  }

  _isAbbreviation(text, dotIndex) {
    const before = text.substring(0, dotIndex);
    const wordMatch = before.match(/(\w+)$/);
    if (!wordMatch) return false;
    const word = wordMatch[1].toLowerCase();

    // Check known abbreviations
    if (this.abbreviations.has(word)) return true;

    // Single letter followed by dot (e.g., "e.g.", "i.e.")
    if (word.length === 1) return true;

    return false;
  }

  flush() {
    const remaining = this.buffer.trim();
    if (remaining) {
      this.onSentence(remaining);
      this.buffer = "";
    }
  }

  clear() {
    this.buffer = "";
  }
}

module.exports = { SentenceBuffer };
