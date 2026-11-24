/**
 * Remove the directory entries from a zip archive, with no external `zip` program (SM-2082).
 *
 * `git archive --format=zip` writes an entry for each directory, but the Go module zip format has
 * none. With them, `go mod verify` reports the extracted module as modified. The function copies
 * each other record byte for byte, and it changes only the offsets of the central directory and of
 * its end record. It refuses a ZIP64 archive, a split archive, and a record it cannot find.
 */

const localHeaderSignature = 0x04034b50;
const centralHeaderSignature = 0x02014b50;
const endSignature = 0x06054b50;
const zip64LocatorSignature = 0x07064b50;
const centralHeaderLength = 46;
const endLength = 22;

interface CentralEntry {
  name: string;
  localOffset: number;
  header: Buffer;
}

/**
 * Find the end record. The archive comment can hold bytes that look like an end record, so the
 * search takes the last candidate whose central directory ends at the candidate. If no candidate
 * agrees with its central directory, the search returns the candidate nearest to the end, and the
 * caller names the problem.
 */
function findEnd(archive: Buffer): number {
  const earliest = Math.max(0, archive.length - endLength - 0xffff);
  let first: number | undefined;
  for (let offset = archive.length - endLength; offset >= earliest; offset -= 1) {
    if (
      archive.readUInt32LE(offset) !== endSignature ||
      offset + endLength + archive.readUInt16LE(offset + 20) !== archive.length
    ) {
      continue;
    }
    first ??= offset;
    const count = archive.readUInt16LE(offset + 10);
    const centralOffset = archive.readUInt32LE(offset + 16);
    if (
      centralOffset + archive.readUInt32LE(offset + 12) === offset &&
      (count === 0 || archive.readUInt32LE(centralOffset) === centralHeaderSignature)
    ) {
      return offset;
    }
  }
  if (first === undefined) {
    throw new Error("The archive has no zip end of central directory record.");
  }
  return first;
}

export function withoutDirectoryEntries(archive: Buffer): Buffer {
  const end = findEnd(archive);
  if (end >= 20 && archive.readUInt32LE(end - 20) === zip64LocatorSignature) {
    throw new Error("The archive is a ZIP64 archive, which this function does not rewrite.");
  }
  if (archive.readUInt16LE(end + 4) !== 0 || archive.readUInt16LE(end + 6) !== 0) {
    throw new Error("The archive is split across disks.");
  }
  const count = archive.readUInt16LE(end + 10);
  const centralSize = archive.readUInt32LE(end + 12);
  const centralOffset = archive.readUInt32LE(end + 16);
  if (archive.readUInt16LE(end + 8) !== count || centralOffset + centralSize !== end) {
    throw new Error("The zip end of central directory record does not match the archive.");
  }

  const entries: CentralEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (
      cursor + centralHeaderLength > end ||
      archive.readUInt32LE(cursor) !== centralHeaderSignature
    ) {
      throw new Error(`Central directory entry ${index} has no valid header.`);
    }
    const nameLength = archive.readUInt16LE(cursor + 28);
    const length =
      centralHeaderLength +
      nameLength +
      archive.readUInt16LE(cursor + 30) +
      archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    if (
      cursor + length > end ||
      localOffset + 30 > centralOffset ||
      archive.readUInt32LE(localOffset) !== localHeaderSignature
    ) {
      throw new Error(`Central directory entry ${index} does not point to a local header.`);
    }
    entries.push({
      name: archive.toString(
        "utf8",
        cursor + centralHeaderLength,
        cursor + centralHeaderLength + nameLength,
      ),
      localOffset,
      header: archive.subarray(cursor, cursor + length),
    });
    cursor += length;
  }
  if (cursor !== end) {
    throw new Error("The central directory has bytes after its last entry.");
  }

  // A record runs from its local header to the next local header, or to the central directory.
  // Thus a data descriptor after the file data stays with its record.
  const byOffset = entries.toSorted((left, right) => left.localOffset - right.localOffset);
  const recordEnd = new Map<CentralEntry, number>();
  byOffset.forEach((entry, index) => {
    recordEnd.set(entry, byOffset[index + 1]?.localOffset ?? centralOffset);
  });

  const records: Buffer[] = [];
  const newOffset = new Map<CentralEntry, number>();
  let written = 0;
  for (const entry of byOffset) {
    if (entry.name.endsWith("/")) continue;
    const record = archive.subarray(entry.localOffset, recordEnd.get(entry));
    newOffset.set(entry, written);
    records.push(record);
    written += record.length;
  }
  // The central directory keeps its own order.
  const headers = entries.flatMap((entry) => {
    const offset = newOffset.get(entry);
    if (offset === undefined) return [];
    const header = Buffer.from(entry.header);
    header.writeUInt32LE(offset, 42);
    return [header];
  });

  const centralDirectory = Buffer.concat(headers);
  const endRecord = Buffer.from(archive.subarray(end));
  endRecord.writeUInt16LE(headers.length, 8);
  endRecord.writeUInt16LE(headers.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(written, 16);
  return Buffer.concat([...records, centralDirectory, endRecord]);
}
