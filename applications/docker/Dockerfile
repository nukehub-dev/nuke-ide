# syntax=docker/dockerfile:1
#
# NukeIDE all-in-one image: Theia browser IDE + the 'trame' conda environment
# with all Python backends (OpenMC, Trame/ParaView, CAD toolchain).
#
# Build:  docker compose -f applications/docker/compose.yml build
# Run:    docker compose -f applications/docker/compose.yml up
# Open:   http://localhost:3000
#
# Optional extensions can be left out of the bundled IDE via build args, e.g.:
#   docker build --build-arg NUKE_EXTENSIONS=all ...            # also bundle nukelab-integration (hub-only, off by default)
#   docker build --build-arg NUKE_EXCLUDE_EXTENSIONS=nuke-sysmon ...
# (see scripts/with-extension-set.js; unset args bundle every extension except nukelab-integration)

###############################################################################
# Stage 1 — build the Theia browser bundle
###############################################################################
FROM docker.io/library/node:22-bookworm AS build

# Extension selection for `yarn build:browser` (scripts/with-extension-set.js).
ARG NUKE_EXTENSIONS
ARG NUKE_EXCLUDE_EXTENSIONS
ENV NUKE_EXTENSIONS=$NUKE_EXTENSIONS \
    NUKE_EXCLUDE_EXTENSIONS=$NUKE_EXCLUDE_EXTENSIONS

# Native node modules (e.g. native-keymap) need X11/xkbfile headers to compile.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libx11-dev libxkbfile-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/nuke-ide
COPY . .

RUN yarn install --frozen-lockfile \
    && yarn build:browser \
    && yarn download:plugins \
    # Slim the runtime payload: download caches and dev-only dependencies the
    # browser backend never loads. Must happen in this stage so the files never
    # reach the final image layers.
    && rm -rf /root/.cache \
    node_modules/electron \
    node_modules/electron-builder \
    node_modules/app-builder-lib \
    node_modules/@electron \
    node_modules/lerna \
    node_modules/prettier \
    node_modules/typescript

###############################################################################
# Stage 2 — runtime: miniforge + 'trame' conda env + built app
###############################################################################
FROM docker.io/condaforge/miniforge3:latest AS runtime

# System libraries needed by gmsh (libXft/libGL family) and the OCP/cadquery
# VTK bindings — even though rendering is headless, these wheels link X/GL.
# libosmesa6 is not optional: the container has no X server and no EGL device,
# so conda VTK's only working GL backend is the OSMesa software renderer —
# without it every ParaView render fails (caught by render_smoke_test.py).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglu1-mesa libxft2 libxext6 libxrender1 \
    libxinerama1 libxcursor1 libxfixes3 libxi6 \
    libosmesa6 \
    && rm -rf /var/lib/apt/lists/*

# Python backend environment (OpenMC, Trame/ParaView, CAD toolchain, Node 22).
# Node comes from conda so no separate Node installation is needed.
COPY applications/docker/environment.yml /tmp/environment.yml
# Large wheels (ParaView/VTK, OCCT, MOAB) can hit flaky connections; be generous
# with retries for both conda package fetches and the pip subprocess.
ENV PIP_RETRIES=10 \
    PIP_TIMEOUT=120
RUN conda config --set remote_max_retries 10 \
    && conda env create -f /tmp/environment.yml \
    && conda clean -afy \
    && rm /tmp/environment.yml \
    # Keep pip's download cache out of the image layers
    && rm -rf /root/.cache

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
