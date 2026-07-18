# syntax=docker/dockerfile:1
#
# NukeIDE all-in-one image: Theia browser IDE + the 'trame' conda environment
# with all Python backends (OpenMC, Trame/ParaView, CAD toolchain).
#
# Build:  docker compose -f applications/docker/compose.yml build
# Run:    docker compose -f applications/docker/compose.yml up
# Open:   http://localhost:3000

###############################################################################
# Stage 1 — build the Theia browser bundle
###############################################################################
FROM node:22-bookworm AS build

WORKDIR /opt/nuke-ide
COPY . .

RUN yarn install --frozen-lockfile \
    && yarn build:browser \
    && yarn download:plugins

###############################################################################
# Stage 2 — runtime: miniforge + 'trame' conda env + built app
###############################################################################
FROM condaforge/miniforge3:latest AS runtime

# Python backend environment (OpenMC, Trame/ParaView, CAD toolchain, Node 22).
# Node comes from conda so no separate Node installation is needed.
COPY applications/docker/environment.yml /tmp/environment.yml
RUN conda env create -f /tmp/environment.yml \
    && conda clean -afy \
    && rm /tmp/environment.yml

# Built application (browser bundle, extensions, plugins, node_modules)
WORKDIR /opt/nuke-ide
COPY --from=build /opt/nuke-ide /opt/nuke-ide

# Headless VTK/ParaView + unbuffered Python output for backend log scraping.
# The ide env's bin dir provides both `python` and `node`.
ENV QT_QPA_PLATFORM=offscreen \
    VTK_USE_OFFSCREEN=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/conda/envs/ide/bin:${PATH}"

EXPOSE 3000

WORKDIR /opt/nuke-ide/applications/browser
# nuke-core auto-detects the 'ide' conda env (it satisfies all package
# requirements), so no IDE configuration is needed inside the container.
CMD ["node", "../../node_modules/.bin/theia", "start", \
     "--plugins=local-dir:../../plugins", \
     "--hostname=0.0.0.0", "--port=3000"]
