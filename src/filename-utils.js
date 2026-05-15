function sanitizeFilename(input, maxLength = 80) {
  if (!input) return 'unknown';
  // Remove Windows-forbidden chars
  let name = String(input).replace(/[<>:"/\\|?*]/g, '');
  // Remove control chars
  name = name.replace(/[\x00-\x1f]/g, '');
  // Trim dots and spaces (Windows trailing restriction)
  name = name.replace(/[. ]+$/, '');
  // Truncate
  if (name.length > maxLength) {
    name = name.substring(0, maxLength).replace(/[. ]+$/, '');
  }
  return name || 'unknown';
}

function makeFilename(author, description, awemeId) {
  const safeAuthor = sanitizeFilename(author, 20);
  let desc = sanitizeFilename(description, 30);
  if (!desc) desc = '抖音视频';

  // Remove duplicates: if desc starts with author, just use desc
  if (desc.startsWith(safeAuthor)) {
    return `${desc}_${awemeId}.mp4`;
  }
  return `${safeAuthor}_${desc}_${awemeId}.mp4`;
}

module.exports = { sanitizeFilename, makeFilename };
