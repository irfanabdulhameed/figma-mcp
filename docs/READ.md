# Read view-only files (`figma-cli read`)

Every other figma-cli command runs through Figma's Plugin API, and Figma
doesn't expose that API in files you can only view. So with view access, even
reading fails. `figma-cli read` works without edit access. It downloads a
file's layers the way Figma Desktop does when it shows the file, saves them as
a local snapshot, and answers questions from that snapshot.

It is read-only by design: nothing in it can change a file.

## Use

```bash
figma-cli read pull "https://www.figma.com/design/<key>/<name>"   # whole file
figma-cli read pull <url> --page "Checkout,Settings"                # some pages (names or ids)
figma-cli read pull <url> --node 12:345                             # one frame and what's under it
figma-cli read pull                                                 # the file open in Figma

figma-cli read pages                       # pages, and which were read
figma-cli read tree --page Checkout -d 2   # outline (add --expand to open instances)
figma-cli read tree 12:345 --expand --json # nested JSON of one frame
figma-cli read find "Button" --type INSTANCE
figma-cli read node "I12:345;67:89"        # everything known about one layer
figma-cli read texts --page Checkout       # every visible text, instances included
figma-cli read vars                        # variables, values per mode
```

Snapshots are saved in `--dir`, else `$FIGMA_CLI_READ_DIR`, else `./figma-read`,
one JSON file per Figma file. Pulling a page or a node into a file that
already has a snapshot adds to it (`--no-merge` replaces it). The query
commands use the newest snapshot; pick another with `--from <path | file key | name>`.

## What you need

- Figma Desktop with its debug port on. Running `figma-cli connect` once
  sets this up.
- Any design file open in Figma Desktop. It only hosts the connection, so the
  file you read doesn't have to be the open one (`--tab <title>` picks the host tab).
- Access to the file on the account signed in to Figma. Figma's server checks
  it: you can read what you can open.

## How it works

1. figma-cli opens a second, viewer-role multiplayer connection from inside an
   open Figma tab. It is signed in as you, and no cookie or token leaves Figma.
   The tab's own connection is not touched, and Figma is never reloaded.
2. The server's first message carries its own data schema (Kiwi format), so
   figma-cli decodes with what the server sends. It ships no copy of the format.
3. figma-cli asks for the page list, then for each page (or node) with
   read-only scene-graph queries. Figma replies with the layers, plus the main
   components, variables and styles they use.
4. figma-cli turns the layers into compact summaries using Plugin API names:
   `PAGE`, `COMPONENT`, `COMPONENT_SET`, `GROUP`, `SLOT`, frame-relative x/y,
   width/height, fills as hex, auto layout, text and typography, variables and
   styles.

## Instances

Figma doesn't send the layers inside instances; its client rebuilds them from
the main component. `read` does the same. Instance layers get the Plugin API's
ids (`I<instance>;<layer>`, with one more `;<id>` per nested instance), and the
rebuild applies:

- overrides: text, visibility, fills, renames, swaps, size;
- component properties: text, boolean visibility, instance swap and slots,
  matched across variants;
- swaps: the new component's name and look. A swap made by an outer override
  starts fresh, without the overrides from where the instance was placed;
- the sizes and positions Figma stored for the instance, and the layer's
  constraints when the instance is resized;
- text styles, fill styles and bound variables, resolved to their current values.

## How accurate it is

Checked against the Plugin API on files with edit access: 17,093 layers across
26 screens and pages from three files (a large design system with hi-fi
screens, a mobile file and a marketing site). Ids, types, names, text,
visibility, sizes, positions, main components, fill colours and font sizes
matched on every layer but two:

- one fill came out 1/255 off, because the variable's value and the colour stored on the layer differ;
- one text height: a component's text style had changed since Figma last
  stored that instance's layout. Figma Desktop re-lays out text when it opens a
  file; `read` can only report what is stored.

## Limits

- Read only. No exports or screenshots: images appear as their hashes, and
  vector geometry isn't included.
- Auto layout is not recalculated. Sizes and positions inside instances come
  from what Figma stored. That is almost always current, but can lag after a
  component changes (see above).
- Variables resolve in each collection's default mode. Frames that switch a
  collection to another mode are not applied yet.
- It uses Figma's internal protocol. A Figma update can break it; when that
  happens, `read pull` fails with a clear error and nothing is written.
- A snapshot is a moment in time. Pull again to see newer edits.

Use it only on files you're allowed to read. If a file's owner has turned off
copying for viewers, respect that: `read` doesn't check it.
