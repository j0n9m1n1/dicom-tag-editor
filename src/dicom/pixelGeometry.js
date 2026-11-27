// A decoded frame can have several full-size working and display buffers.
export const MAX_FRAME_PIXELS = 4096 * 4096;

export function checkedPixelCount(rows, cols) {
  const count = rows * cols;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > 65535 || cols > 65535 ||
      count > MAX_FRAME_PIXELS) {
    throw new RangeError(`Invalid image dimensions or image exceeds ${MAX_FRAME_PIXELS} pixels.`);
  }
  return count;
}
