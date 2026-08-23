package dashboard

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"io"
	"testing"
)

func TestBundleContainsApplicationAndLoginTemplate(t *testing.T) {
	manifestFile, err := Files.Open("bundle.json")
	if err != nil {
		t.Fatal(err)
	}
	defer manifestFile.Close()
	manifest := struct {
		Archive string `json:"archive"`
	}{}
	if err := json.NewDecoder(manifestFile).Decode(&manifest); err != nil {
		t.Fatal(err)
	}
	archive, err := Files.Open(manifest.Archive)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	gzipReader, err := gzip.NewReader(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer gzipReader.Close()

	found := map[string]bool{}
	reader := tar.NewReader(gzipReader)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if header.Name == "app/index.html" || header.Name == "login.html" {
			found[header.Name] = true
		}
	}
	for _, name := range []string{"app/index.html", "login.html"} {
		if !found[name] {
			t.Fatalf("dashboard bundle does not contain %s", name)
		}
	}
}
