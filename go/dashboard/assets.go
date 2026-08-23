// Package dashboard exposes the versioned, language-neutral dashboard browser bundle.
package dashboard

import "embed"

// Files contains bundle.json and the archive named by it.
//
//go:embed bundle.json *.tar.gz
var Files embed.FS
