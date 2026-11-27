/** Construct a proleptic Gregorian date without Date.UTC's 1900 offset. */
export function parseDicomCalendarDate(year, month, day) {
  if (year < 1 || year > 9999) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

export function isValidDicomDateTime(value) {
  const parts = /^(\d{4})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:\.\d{1,6})?)?)?)?)?)?([+-]\d{4})?$/.exec(value);
  if (!parts) return false;
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00', offset] = parts;
  if (!parseDicomCalendarDate(Number(year), Number(month), Number(day)) || hour > '23' || minute > '59' || second > '60') {
    return false;
  }
  if (!offset) return true;
  const offsetMinutes = Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3));
  return offset !== '-0000' && offset.slice(3) <= '59' && offsetMinutes <= (offset[0] === '+' ? 840 : 720);
}
