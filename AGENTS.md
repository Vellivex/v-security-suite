# Vellivex public identity and publishing policy

The public project identity is **Vellivex**, with project contact
**v@vellivex.com**. Use this identity for original project commits and releases.
When an owner's name is needed in public copy, use the owner alias **V**.
Set both the author and committer identity in the repository. A local Git name
alone does not change the public account credited by a hosting service.

Run `python3 scripts/install-public-identity-hooks.py` in each new checkout before
committing or publishing. It sets the project identity and installs `pre-commit`
and `pre-push` checks in this repository's local Git configuration only. Existing
active hooks or a different hooks path must be reviewed before replacement.
The checks inspect staged bytes, proposed commit identity, and the complete
commit metadata and text blobs reachable from each proposed push source. This
includes historical content and source commits outside the checked-out branch.

Keep personal account names, private contact information and unrelated business
identifiers out of public copy, source, Git metadata, links, release packages,
email templates and payment screens. Preserve authentic upstream licence and
copyright notices; do not relabel another contributor's work as project work.

Before publishing, run `scripts/build.sh`. Its identity check must pass against
tracked text, paths, all reachable Git commit metadata and historical text blobs.
The publishing HEAD
must use `Vellivex <v@vellivex.com>` for both author and committer. The CI identity
check must also pass. Do not suppress a failure with an unrestricted allowlist
or publish from a shallow checkout that omits relevant history.

Binary assets, images, old downloads, public workflow actors, repository profiles,
customer emails and payment pages need their own review: a source scan does not
inspect them. Use a dedicated Vellivex publishing account for public hosting
actions. Required repository checks and deployment controls must be configured
outside this file; this policy does not create those controls by itself.
Local hooks can be disabled or bypassed, so they do not replace required hosting
checks. They cannot identify the account authenticated to the hosting service;
verify that the publishing actor uses a dedicated Vellivex account separately.

When an identity exposure is found, stop the affected publication, remove it from
current content and relevant history, check generated downloads, and verify the
public result. Keep private recovery evidence outside the public repository.
