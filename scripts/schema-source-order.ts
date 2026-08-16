const RELATIONS_MARKER = "-- Relations, supporting indexes, and relation triggers.";
const DEPENDENT_OBJECTS_MARKER = "-- Objects that depend on the complete relation block.";
const relationDeclaration = /^CREATE (?:TABLE|(?:UNIQUE )?INDEX|SEQUENCE)\b/gm;

function lineNumber(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

export function assertSchemaSourceOrder(source: string): void {
  const relationsOffset = source.indexOf(RELATIONS_MARKER);
  const dependentObjectsOffset = source.indexOf(DEPENDENT_OBJECTS_MARKER);

  if (
    relationsOffset < 0 ||
    dependentObjectsOffset < 0 ||
    relationsOffset >= dependentObjectsOffset
  ) {
    throw new Error(
      `sql/schema/current.sql must contain ordered "${RELATIONS_MARKER}" and "${DEPENDENT_OBJECTS_MARKER}" sections`,
    );
  }

  relationDeclaration.lastIndex = dependentObjectsOffset;
  const misplaced = relationDeclaration.exec(source);
  if (misplaced) {
    throw new Error(
      `sql/schema/current.sql declares ${misplaced[0]} on line ${lineNumber(source, misplaced.index)} after the operational-function section`,
    );
  }
}
