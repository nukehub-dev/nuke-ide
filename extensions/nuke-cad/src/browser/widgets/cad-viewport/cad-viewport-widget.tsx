// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice,
//    this list of conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.
// SPDX-License-Identifier: BSD-2-Clause
// *****************************************************************************

/**
 * CAD viewport widget.
 *
 * Renders the tessellated B-rep using three.js. Face/solid picking updates the
 * shared selection state; selecting a manifest row will highlight the matching
 * geometry.
 *
 * @module nuke-cad/browser/widgets
 */

import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { URI } from '@theia/core/lib/common/uri';
import * as THREE from 'three';

import { NukeCadBackendService, GeometryBuildResult } from '../../../common/nuke-cad-protocol';
import { NukeCadStateManager, CadSelection } from '../../state/nuke-cad-state-manager';
import './cad-viewport.css';

interface TessFace {
    readonly faceId: number;
    readonly nodes: number[][];
    readonly triangles: number[][];
}

interface TessSolid {
    readonly solidId: number;
    readonly faces: TessFace[];
}

interface TessData {
    readonly version: number;
    readonly tolerance: number;
    readonly boundingBox: { readonly min: number[]; readonly max: number[] };
    readonly solids: TessSolid[];
}

@injectable()
export class CadViewportWidget extends ReactWidget {
    static readonly ID = 'nuke-cad-viewport-widget';
    static readonly LABEL = 'CAD Viewport';

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(NukeCadStateManager)
    protected readonly stateManager: NukeCadStateManager;

    @inject(ThemeService)
    protected readonly themeService: ThemeService;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    @inject(NukeCadBackendService)
    protected readonly backendService: NukeCadBackendService;

    private tessData?: TessData;

    @postConstruct()
    protected init(): void {
        this.id = CadViewportWidget.ID;
        this.title.label = CadViewportWidget.LABEL;
        this.title.caption = CadViewportWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-globe';

        this.stateManager.onModelChange((model) => {
            this.tessData = undefined;
            if (model?.result.tessPath) {
                this.loadTessellation(model.result.tessPath).catch((err) => {
                    console.error('[CadViewport] Failed to load tessellation:', err);
                });
            }
            this.update();
        });

        this.themeService.onDidColorThemeChange(() => this.update());
        this.update();
    }

    private async loadTessellation(path: string): Promise<void> {
        const content = await this.fileService.readFile(new URI(path));
        this.tessData = JSON.parse(content.value.toString()) as TessData;
        this.update();
    }

    /**
     * Prompt for a CAD model script or STEP file and load it into the viewport.
     */
    protected async openModel(): Promise<void> {
        const uri = await this.fileDialogService.showOpenDialog({
            title: 'Open CAD Model',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'CAD Models': ['py', 'step', 'stp']
            }
        });
        if (!uri) {
            return;
        }

        const filePath = uri.path.toString();
        const ext = uri.path.ext.toLowerCase();
        const sourceType: 'script' | 'step' = ext === '.py' ? 'script' : 'step';

        this.messageService.info(`Loading CAD model: ${filePath}`);
        try {
            const result: GeometryBuildResult = await this.backendService.buildGeometry({
                scriptPath: filePath,
                sourceType
            });
            if (result.success) {
                this.stateManager.setModel({
                    scriptPath: filePath,
                    result,
                    manifest: result.regionManifest
                });
                this.messageService.info(`Loaded ${result.solidCount ?? 0} solids, ${result.triangleCount ?? 0} triangles`);
            } else {
                this.messageService.error(result.error || 'Failed to load CAD model.');
            }
        } catch (error) {
            this.messageService.error(error instanceof Error ? error.message : String(error));
        }
    }

    protected render(): React.ReactNode {
        return (
            <CadViewportComponent
                tessData={this.tessData}
                selection={this.stateManager.selection}
                onSelect={(selection) => this.stateManager.setSelection(selection)}
                onOpenModel={() => this.openModel()}
            />
        );
    }
}

interface CadViewportComponentProps {
    readonly tessData?: TessData;
    readonly selection: CadSelection;
    readonly onSelect: (selection: CadSelection) => void;
    readonly onOpenModel: () => void;
}

function CadViewportComponent(props: CadViewportComponentProps): React.ReactElement {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const rendererRef = React.useRef<THREE.WebGLRenderer | undefined>(undefined);

    React.useEffect(() => {
        if (!containerRef.current || props.tessData === undefined) {
            return undefined;
        }

        const container = containerRef.current;
        let disposed = false;
        let cleanup: (() => void) | undefined;

        (async () => {
            const [{ OrbitControls }] = await Promise.all([import('three/examples/jsm/controls/OrbitControls.js')]);
            if (disposed) {
                return;
            }
            cleanup = initViewport(container, props, OrbitControls, rendererRef);
        })().catch((err) => {
            console.error('[CadViewport] Failed to initialize viewport:', err);
        });

        return () => {
            disposed = true;
            cleanup?.();
        };
    }, [props.tessData, props.selection, props.onSelect]);

    if (props.tessData === undefined) {
        return (
            <div ref={containerRef} className="cad-viewport empty">
                <span>Open a CAD model to view geometry.</span>
                <button
                    className="theia-button open-cad-model-button"
                    onClick={props.onOpenModel}
                    title="Open a build123d/CadQuery script or STEP file"
                >
                    <span className="codicon codicon-folder-opened" /> Open CAD Model...
                </button>
            </div>
        );
    }

    return <div ref={containerRef} className="cad-viewport" />;
}

function initViewport(
    container: HTMLDivElement,
    props: CadViewportComponentProps,
    OrbitControlsCtor: new (
        camera: THREE.Camera,
        domElement: HTMLElement
    ) => {
        target: THREE.Vector3;
        update: () => void;
    },
    rendererRef: React.MutableRefObject<THREE.WebGLRenderer | undefined>
): () => void {
    const width = container.clientWidth || 400;
    const height = container.clientHeight || 300;

    const scene = new THREE.Scene();
    const background = readThemeColor(container, '--theia-editor-background', '#1e1e1e');
    scene.background = new THREE.Color(background);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 10000);
    const bbox = props.tessData!.boundingBox;
    const center = new THREE.Vector3((bbox.min[0] + bbox.max[0]) / 2, (bbox.min[1] + bbox.max[1]) / 2, (bbox.min[2] + bbox.max[2]) / 2);
    const diag = new THREE.Vector3(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]).length();
    camera.position.copy(center.clone().add(new THREE.Vector3(diag, diag, diag)));
    camera.lookAt(center);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControlsCtor(camera, renderer.domElement);
    controls.target.copy(center);
    controls.update();

    const meshes: THREE.Mesh[] = [];
    const group = new THREE.Group();
    scene.add(group);

    const baseColor = new THREE.Color(readThemeColor(container, '--theia-foreground', '#cccccc'));
    const selectedColor = new THREE.Color(readThemeColor(container, '--theia-focusBorder', '#007fd4'));

    for (const solid of props.tessData!.solids) {
        for (const face of solid.faces) {
            const geometry = buildFaceGeometry(face);
            const material = new THREE.MeshStandardMaterial({
                color: baseColor,
                roughness: 0.6,
                metalness: 0.1,
                side: THREE.DoubleSide
            });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.userData = { solidId: solid.solidId, faceId: face.faceId };
            group.add(mesh);
            meshes.push(mesh);
        }
    }

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(diag, diag, diag);
    scene.add(directional);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const onClick = (event: MouseEvent) => {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const intersects = raycaster.intersectObjects(meshes, false);
        if (intersects.length > 0) {
            const data = intersects[0].object.userData;
            props.onSelect({ solidId: data.solidId as number, faceId: data.faceId as number });
        } else {
            props.onSelect({});
        }
    };
    renderer.domElement.addEventListener('click', onClick);

    for (const mesh of meshes) {
        const data = mesh.userData;
        const isSelected =
            props.selection.faceId !== undefined && data.faceId === props.selection.faceId && data.solidId === props.selection.solidId;
        (mesh.material as THREE.MeshStandardMaterial).color.copy(isSelected ? selectedColor : baseColor);
    }

    let running = true;
    const animate = () => {
        if (!running) {
            return;
        }
        requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
    };
    animate();

    const resizeObserver = new ResizeObserver(() => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w > 0 && h > 0) {
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            renderer.setSize(w, h);
        }
    });
    resizeObserver.observe(container);

    return () => {
        running = false;
        resizeObserver.disconnect();
        renderer.domElement.removeEventListener('click', onClick);
        renderer.dispose();
        if (renderer.domElement.parentElement === container) {
            container.removeChild(renderer.domElement);
        }
        for (const mesh of meshes) {
            mesh.geometry.dispose();
            (mesh.material as THREE.Material).dispose();
        }
        rendererRef.current = undefined;
    };
}

function buildFaceGeometry(face: TessFace): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    const vertices: number[] = [];
    const indices: number[] = [];
    for (const tri of face.triangles) {
        const a = face.nodes[tri[0]];
        const b = face.nodes[tri[1]];
        const c = face.nodes[tri[2]];
        const base = vertices.length / 3;
        vertices.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        indices.push(base, base + 1, base + 2);
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
}

function readThemeColor(element: HTMLElement, variable: string, fallback: string): string {
    const value = getComputedStyle(element).getPropertyValue(variable).trim();
    return value || fallback;
}
