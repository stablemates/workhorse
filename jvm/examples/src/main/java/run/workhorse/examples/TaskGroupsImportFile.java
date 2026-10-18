package run.workhorse.examples;

import java.util.List;

/** The uploaded file that the snippets of the site page about task groups import. */
public record TaskGroupsImportFile(List<String> rows) {}
