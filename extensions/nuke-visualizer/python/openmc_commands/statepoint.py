"""
Statepoint Viewer commands for OpenMC.
Provides comprehensive statepoint file analysis.
"""

import json
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    import h5py
    import numpy as np
    HAS_H5PY = True
except ImportError:
    HAS_H5PY = False
    
try:
    from paraview import simple
    import vtk
    from vtk.util import numpy_support
    HAS_PARAVIEW = True
except ImportError:
    HAS_PARAVIEW = False


def cmd_statepoint_info(args):
    """Get full statepoint information for the Statepoint Viewer."""
    if not HAS_H5PY:
        print(json.dumps({'error': 'h5py not installed'}))
        return 1
    
    try:
        with h5py.File(args.statepoint, 'r') as f:
            result = {
                'file': args.statepoint,
                'runMode': 'unknown',
                'nBatches': 0,
                'nParticles': 0,
                'nInactive': 0,
                'nRealizations': 0,
                'seed': 0,
                'energyMode': 'unknown',
                'generationsPerBatch': 1,
                'currentBatch': 0,
                'version': '',
                'kCombined': None,
                'kGeneration': None,
                'kColAbs': None,
                'kColTra': None,
                'kAbsTra': None,
                'nSourceParticles': 0,
                'hasSourceBank': False,
                'runtime': {},
                'globalTallies': [],
                'tallies': [],
                'filters': [],
                'meshes': []
            }
            
            # Simulation metadata
            if 'run_mode' in f:
                mode = f['run_mode'][()]
                result['runMode'] = mode.decode('utf-8') if isinstance(mode, bytes) else str(mode)
            
            if 'n_batches' in f:
                result['nBatches'] = int(f['n_batches'][()])
            
            if 'n_particles' in f:
                result['nParticles'] = int(f['n_particles'][()])
                
            if 'n_inactive' in f:
                result['nInactive'] = int(f['n_inactive'][()])
                
            if 'n_realizations' in f:
                result['nRealizations'] = int(f['n_realizations'][()])
                
            if 'seed' in f:
                result['seed'] = int(f['seed'][()])
                
            if 'energy_mode' in f:
                emode = f['energy_mode'][()]
                result['energyMode'] = emode.decode('utf-8') if isinstance(emode, bytes) else str(emode)
                
            if 'generations_per_batch' in f:
                result['generationsPerBatch'] = int(f['generations_per_batch'][()])
                
            if 'current_batch' in f:
                result['currentBatch'] = int(f['current_batch'][()])
            
            # Get version - try openmc_version first (more reliable), fall back to version
            if 'openmc_version' in f.attrs:
                ver = f.attrs['openmc_version']
                if hasattr(ver, '__iter__') and not isinstance(ver, (str, bytes)):
                    ver = '.'.join(map(str, ver))
                else:
                    ver = ver.decode('utf-8') if isinstance(ver, bytes) else str(ver)
                result['version'] = ver
            elif 'version' in f.attrs:
                ver = f.attrs['version']
                # Handle numpy array or bytes
                if hasattr(ver, '__iter__') and not isinstance(ver, (str, bytes)):
                    ver = '.'.join(map(str, ver))
                else:
                    ver = ver.decode('utf-8') if isinstance(ver, bytes) else str(ver)
                result['version'] = ver
            
            # K-effective results
            if 'k_combined' in f:
                k_comb = f['k_combined'][...]
                result['kCombined'] = [float(k_comb[0]), float(k_comb[1])]
            
            if 'k_generation' in f:
                k_gen = f['k_generation'][...]
                result['kGeneration'] = k_gen.tolist()
            
            # Alternative k-estimators
            if 'k_col_abs' in f:
                result['kColAbs'] = float(f['k_col_abs'][()])
            if 'k_col_tra' in f:
                result['kColTra'] = float(f['k_col_tra'][()])
            if 'k_abs_tra' in f:
                result['kAbsTra'] = float(f['k_abs_tra'][()])
            
            # Source bank
            if 'source_bank' in f:
                source_bank = f['source_bank']
                result['nSourceParticles'] = len(source_bank)
                result['hasSourceBank'] = True
            
            # Runtime breakdown
            if 'runtime' in f:
                runtime_group = f['runtime']
                
                def get_runtime_value(group, *keys):
                    """Try multiple key variations to read runtime values."""
                    for key in keys:
                        try:
                            if key in group:
                                val = group[key]
                                # Handle both scalar and array datasets
                                if isinstance(val, h5py.Dataset):
                                    arr = val[()]
                                    if hasattr(arr, '__len__') and hasattr(arr, 'size') and arr.size > 0:
                                        return float(arr.flat[0])
                                    return float(arr)
                        except Exception:
                            pass
                    return 0
                
                # Try both space-separated and underscore keys (OpenMC may use either)
                total_init = get_runtime_value(runtime_group, 'total initialization', 'total_initialization', 'init')
                reading_xs = get_runtime_value(runtime_group, 'reading cross sections', 'reading_cross_sections', 'reading_xs')
                inactive_batches = get_runtime_value(runtime_group, 'inactive batches', 'inactive_batches')
                active_batches = get_runtime_value(runtime_group, 'active batches', 'active_batches')
                simulation = get_runtime_value(runtime_group, 'simulation', 'active')
                transport = get_runtime_value(runtime_group, 'transport')
                syn_fission_bank = get_runtime_value(runtime_group, 'synchronizing fission bank', 'synchronizing_fission_bank')
                source_sampling = get_runtime_value(runtime_group, 'sampling source sites', 'sampling_source_sites')
                tally_accum = get_runtime_value(runtime_group, 'accumulating tallies', 'accumulating_tallies')
                writing_sp = get_runtime_value(runtime_group, 'writing statepoints', 'writing_statepoints')
                send_recv = get_runtime_value(runtime_group, 'SEND-RECV source sites', 'send_recv_source_sites')
                
                # Get total - try various keys
                total_runtime = get_runtime_value(runtime_group, 'total', 'total time', 'total_time')
                if total_runtime == 0:
                    total_runtime = total_init + simulation
                
                result['runtime'] = {
                    'total': total_runtime,
                    'initialization': total_init,
                    'readingCrossSections': reading_xs,
                    'inactiveBatches': inactive_batches,
                    'activeBatches': active_batches,
                    'simulation': simulation,
                    'transport': transport,
                    'synchronizingFissionBank': syn_fission_bank,
                    'samplingSourceSites': source_sampling,
                    'accumulatingTallies': tally_accum,
                    'writingStatepoints': writing_sp,
                    'sendRecvSourceSites': send_recv,
                }
            
            # Global tallies
            if 'global_tallies' in f:
                global_tallies = f['global_tallies'][...]
                # Global tallies shape is (n_tallies, 3) where 3 = [mean, std_dev, formula]
                global_names = ['Leakage', 'Loss to Fission', 'Fission Neutrons', 'Non-Fission Captures']
                global_scores = ['leakage', 'loss_to_fission', 'fission_neutrons', 'non_fission_captures']
                for i, (name, score) in enumerate(zip(global_names, global_scores)):
                    if i < len(global_tallies):
                        result['globalTallies'].append({
                            'name': name,
                            'score': score,
                            'mean': float(global_tallies[i, 0]),
                            'stdDev': float(global_tallies[i, 1])
                        })
            
            # Tallies
            if 'tallies' in f:
                tallies_group = f['tallies']
                for key in tallies_group.keys():
                    if not key.startswith('tally '):
                        continue
                    
                    tally_id = int(key.split()[-1])
                    tally = tallies_group[key]
                    
                    # Get name
                    name = tally.attrs.get('name', f'Tally {tally_id}')
                    if isinstance(name, bytes):
                        name = name.decode('utf-8')
                    
                    # Get scores - OpenMC stores in 'score_bins' dataset
                    scores = []
                    if 'score_bins' in tally:
                        val = tally['score_bins'][()]
                        if isinstance(val, np.ndarray):
                            scores = []
                            for v in val:
                                if isinstance(v, bytes):
                                    scores.append(v.decode('utf-8'))
                                elif isinstance(v, str):
                                    scores.append(v)
                                else:
                                    scores.append(str(v))
                    elif 'score' in tally:
                        val = tally['score'][()]
                        if isinstance(val, np.ndarray):
                            val = [val[()]] if val.ndim == 0 else val.tolist()
                        elif isinstance(val, (bytes, str)):
                            val = [val]
                        scores = [v.decode('utf-8') if hasattr(v, 'decode') else str(v) for v in val]
                    elif 'score' in tally.attrs:
                        val = tally.attrs['score']
                        val = val.decode('utf-8') if hasattr(val, 'decode') else str(val)
                        scores = val.split()
                    
                    # Get nuclides
                    nuclides = []
                    if 'nuclides' in tally:
                        val = tally['nuclides'][()]
                        if isinstance(val, np.ndarray):
                            nuclides = []
                            for v in val:
                                if isinstance(v, bytes):
                                    nuclides.append(v.decode('utf-8'))
                                elif isinstance(v, str):
                                    nuclides.append(v)
                                else:
                                    nuclides.append(str(v))
                    elif 'nuclides' in tally.attrs:
                        val = tally.attrs['nuclides']
                        val = val.decode('utf-8') if hasattr(val, 'decode') else str(val)
                        nuclides = val.split()
                    
                    # Parse filters
                    filters = []
                    has_mesh = False
                    
                    if 'filters' in tally:
                        filters_ref = tally['filters']
                        filters_location = None
                        if 'filters' in f:
                            filters_location = f['filters']
                        elif 'filters' in tallies_group:
                            filters_location = tallies_group['filters']
                        
                        if filters_location:
                            if isinstance(filters_ref, h5py.Dataset):
                                filter_ids = filters_ref[...]
                                for fid in filter_ids.flat:
                                    filter_key = f'filter {int(fid)}'
                                    if filter_key in filters_location:
                                        filter_obj = filters_location[filter_key]
                                        filter_info = _parse_filter(filter_obj, f, tallies_group)
                                        filters.append(filter_info)
                                        if filter_info['type'] == 'mesh':
                                            has_mesh = True
                            elif isinstance(filters_ref, h5py.Group):
                                for filter_key in filters_ref.keys():
                                    filter_obj = filters_ref[filter_key]
                                    filter_info = _parse_filter(filter_obj, f, tallies_group)
                                    filters.append(filter_info)
                                    if filter_info['type'] == 'mesh':
                                        has_mesh = True
                    
                    result['tallies'].append({
                        'id': tally_id,
                        'name': name,
                        'scores': scores,
                        'nuclides': nuclides,
                        'filters': filters,
                        'hasMesh': has_mesh
                    })
            
            # Filters
            if 'tallies' in f and 'filters' in f['tallies']:
                filters_group = f['tallies']['filters']
                for key in filters_group.keys():
                    if not key.startswith('filter '):
                        continue
                    filter_id = int(key.split()[-1])
                    filter_obj = filters_group[key]
                    
                    filter_type = 'unknown'
                    if 'type' in filter_obj:
                        val = filter_obj['type'][()]
                        filter_type = val.decode('utf-8') if hasattr(val, 'decode') else str(val)
                    
                    n_bins = 0
                    if 'n_bins' in filter_obj:
                        n_bins = int(filter_obj['n_bins'][()])
                    
                    result['filters'].append({
                        'id': filter_id,
                        'type': filter_type,
                        'nBins': n_bins
                    })
            
            # Meshes
            if 'tallies' in f and 'meshes' in f['tallies']:
                meshes_group = f['tallies']['meshes']
                for key in meshes_group.keys():
                    if not key.startswith('mesh '):
                        continue
                    mesh_id = int(key.split()[-1])
                    mesh_obj = meshes_group[key]
                    
                    mesh_info = {
                        'id': mesh_id,
                        'type': 'regular',
                        'dimensions': [],
                        'lowerLeft': [],
                        'upperRight': [],
                        'width': []
                    }
                    
                    if 'dimension' in mesh_obj:
                        mesh_info['dimensions'] = mesh_obj['dimension'][()].tolist()
                    if 'lower_left' in mesh_obj:
                        mesh_info['lowerLeft'] = mesh_obj['lower_left'][()].tolist()
                    if 'upper_right' in mesh_obj:
                        mesh_info['upperRight'] = mesh_obj['upper_right'][()].tolist()
                    if 'width' in mesh_obj:
                        mesh_info['width'] = mesh_obj['width'][()].tolist()
                    elif mesh_info['dimensions'] and mesh_info['lowerLeft'] and mesh_info['upperRight']:
                        # Calculate width
                        ur = np.array(mesh_info['upperRight'])
                        ll = np.array(mesh_info['lowerLeft'])
                        dim = np.array(mesh_info['dimensions'])
                        mesh_info['width'] = ((ur - ll) / dim).tolist()
                    
                    result['meshes'].append(mesh_info)
            
            print(json.dumps(result))
            return 0
            
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        return 1


def _parse_filter(filter_obj, f, tallies_group):
    """Parse a filter object and return filter info."""
    filter_type = 'unknown'
    if 'type' in filter_obj:
        val = filter_obj['type'][()]
        filter_type = val.decode('utf-8') if hasattr(val, 'decode') else str(val)
    elif 'type' in filter_obj.attrs:
        val = filter_obj.attrs['type']
        filter_type = val.decode('utf-8') if hasattr(val, 'decode') else str(val)
    
    n_bins = 0
    if 'n_bins' in filter_obj:
        n_bins = int(filter_obj['n_bins'][()])
    elif 'n_bins' in filter_obj.attrs:
        n_bins = int(filter_obj.attrs['n_bins'])
    
    filter_info = {
        'type': filter_type,
        'bins': n_bins
    }
    
    if filter_type == 'mesh':
        # Get mesh info
        mesh_id = None
        if 'bins' in filter_obj:
            bins_data = filter_obj['bins'][()]
            if isinstance(bins_data, np.ndarray) and bins_data.size > 0:
                mesh_id = int(bins_data.flat[0])
            else:
                mesh_id = int(bins_data)
        
        if mesh_id is not None and 'meshes' in tallies_group:
            mesh_key = f'mesh {mesh_id}'
            if mesh_key in tallies_group['meshes']:
                mesh_obj = tallies_group['meshes'][mesh_key]
                if 'dimension' in mesh_obj:
                    filter_info['meshDimensions'] = mesh_obj['dimension'][()].tolist()
                if 'lower_left' in mesh_obj:
                    filter_info['lowerLeft'] = mesh_obj['lower_left'][()].tolist()
                if 'upper_right' in mesh_obj:
                    filter_info['upperRight'] = mesh_obj['upper_right'][()].tolist()
                if 'width' in mesh_obj:
                    filter_info['width'] = mesh_obj['width'][()].tolist()
    
    return filter_info


def cmd_k_generation(args):
    """Get k-generation data for convergence plot."""
    if not HAS_H5PY:
        print(json.dumps({'error': 'h5py not installed'}))
        return 1
    
    try:
        with h5py.File(args.statepoint, 'r') as f:
            if 'k_generation' not in f:
                print(json.dumps({'error': 'No k_generation data in statepoint'}))
                return 1
            
            k_gen = f['k_generation'][...]
            batches = list(range(1, len(k_gen) + 1))
            
            # Calculate cumulative mean and std
            cumulative_mean = []
            cumulative_std = []
            for i in range(1, len(k_gen) + 1):
                mean = np.mean(k_gen[:i])
                std = np.std(k_gen[:i], ddof=1) if i > 1 else 0
                cumulative_mean.append(float(mean))
                cumulative_std.append(float(std))
            
            # Calculate bounds (mean ± 2*std)
            upper_bound = [m + 2*s for m, s in zip(cumulative_mean, cumulative_std)]
            lower_bound = [m - 2*s for m, s in zip(cumulative_mean, cumulative_std)]
            
            result = {
                'batches': batches,
                'kValues': k_gen.tolist(),
                'cumulativeMean': cumulative_mean,
                'cumulativeStdDev': cumulative_std,
                'upperBound': upper_bound,
                'lowerBound': lower_bound
            }
            
            print(json.dumps(result))
            return 0
            
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        return 1


def cmd_source_data(args):
    """Get source particle data for visualization."""
    if not HAS_H5PY:
        print(json.dumps({'error': 'h5py not installed'}))
        return 1
    
    try:
        with h5py.File(args.statepoint, 'r') as f:
            if 'source_bank' not in f:
                print(json.dumps({'error': 'No source_bank in statepoint'}))
                return 1
            
            source_bank = f['source_bank']
            n_particles = len(source_bank)
            
            # Limit particles
            max_p = min(args.max_particles, n_particles)
            stride = n_particles // max_p if n_particles > max_p else 1
            
            positions = []
            energies = []
            weights = []
            directions = []
            
            for i in range(0, n_particles, stride):
                if len(positions) >= max_p:
                    break
                
                particle = source_bank[i]
                r = particle['r']
                positions.append([float(r[0]), float(r[1]), float(r[2])])
                energies.append(float(particle['E']))
                weights.append(float(particle['wgt']))
                u = particle['u']
                directions.append([float(u[0]), float(u[1]), float(u[2])])
            
            result = {
                'positions': positions,
                'energies': energies,
                'weights': weights,
                'directions': directions,
                'totalParticles': n_particles,
                'returnedParticles': len(positions)
            }
            
            print(json.dumps(result))
            return 0
            
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        return 1


def cmd_energy_distribution(args):
    """Get energy distribution histogram."""
    if not HAS_H5PY:
        print(json.dumps({'error': 'h5py not installed'}))
        return 1
    
    try:
        with h5py.File(args.statepoint, 'r') as f:
            if 'source_bank' not in f:
                print(json.dumps({'error': 'No source_bank in statepoint'}))
                return 1
            
            source_bank = f['source_bank']
            energies = source_bank['E'][...]
            weights = source_bank['wgt'][...]
            
            # Create histogram
            counts, bin_edges = np.histogram(energies, bins=args.bins, weights=weights)
            unweighted_counts, _ = np.histogram(energies, bins=args.bins)
            
            bin_centers = (bin_edges[:-1] + bin_edges[1:]) / 2
            
            result = {
                'binEdges': bin_edges.tolist(),
                'binCenters': bin_centers.tolist(),
                'counts': unweighted_counts.tolist(),
                'weightedCounts': counts.tolist()
            }
            
            print(json.dumps(result))
            return 0
            
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        return 1

