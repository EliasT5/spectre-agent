# Spectre updater sidecar — runs the host updater script (scripts/spectre-update.mjs)
# with access to the host Docker socket + the repo, so the Shell can apply updates
# with a button. PRIVILEGED (host Docker) — OFF by default (compose `update` profile).
FROM docker:27-cli

# node → runs the server + the update script; docker-cli-compose → `docker compose`
# against the mounted host socket; git → pull the mounted repo.
RUN apk add --no-cache nodejs docker-cli-compose git

# The repo is bind-mounted at /repo and owned by the host user; trust it so git
# doesn't refuse with "dubious ownership".
RUN git config --global --add safe.directory /repo

COPY server.mjs /app/server.mjs

ENV PORT=8020 REPO_DIR=/repo
WORKDIR /repo
EXPOSE 8020
# The docker:cli base sets ENTRYPOINT ["docker"] — reset it so CMD runs node directly
# (otherwise `node …` is parsed as the `docker node` swarm subcommand).
ENTRYPOINT []
CMD ["node", "/app/server.mjs"]
