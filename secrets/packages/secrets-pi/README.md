# @coffeectx/secrets-pi

Pi coding-agent extension exposing `exec_elevated`.

The extension reads `~/.coffeecode/secrets.yaml`, resolves the active project by
`COFFEECTX_SECRETS_PROJECT` or current working directory, and injects only the
requested configured secrets into the child command environment.
