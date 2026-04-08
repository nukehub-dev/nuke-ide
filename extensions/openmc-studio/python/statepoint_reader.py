#!/usr/bin/env python3
"""
Statepoint Reader Service for OpenMC Studio

Reads OpenMC statepoint HDF5 files and extracts k-effective values,
tally results, and simulation metadata for comparison.

Usage:
    python statepoint_reader.py <statepoint_file> [--json]
    python statepoint_reader.py --compare <file1> <file2> [...] [--json]
    python statepoint_reader.py --depletion <depletion_results.h5> [--json]
"""

import sys
import os
import json
import argparse
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple
import warnings
import numpy as np
from math import sqrt

# Suppress warnings for cleaner output
warnings.filterwarnings('ignore')


class NumpyEncoder(json.JSONEncoder):
    """JSON Encoder that handles numpy types."""
    def default(self, obj):
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            return float(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)


def read_statepoint(filepath: str) -> Dict[str, Any]:
    """
    Read a single statepoint file and extract relevant data.
    
    Args:
        filepath: Path to the statepoint HDF5 file
        
    Returns:
        Dictionary containing k-effective, tallies, and metadata
    """
    try:
        import openmc
        import h5py
    except ImportError as e:
        return {
            'success': False,
            'error': f'Missing dependency: {e}. Please install openmc and h5py.'
        }
    
    filepath = Path(filepath)
    
    if not filepath.exists():
        return {
            'success': False,
            'error': f'File not found: {filepath}'
        }
    
    if not filepath.suffix == '.h5':
        return {
            'success': False,
            'error': f'Not an HDF5 file: {filepath}'
        }
    
    try:
        # Load the statepoint
        sp = openmc.StatePoint(str(filepath))
        
        result = {
            'success': True,
            'filePath': str(filepath.absolute()),
            'fileName': filepath.name,
            'fileSizeMB': round(filepath.stat().st_size / (1024 * 1024), 2),
        }
        
        # Extract k-effective (only for eigenvalue calculations)
        if sp.run_mode == 'eigenvalue':
            # Get k-effective from the statepoint
            k_eff = sp.k_combined
            result['kEff'] = {
                'value': float(k_eff.nominal_value),
                'stdDev': float(k_eff.std_dev)
            }
            
            # Also get generation data if available
            if hasattr(sp, 'n_batches'):
                result['batches'] = sp.n_batches
            if hasattr(sp, 'n_inactive'):
                result['inactiveBatches'] = sp.n_inactive
            if hasattr(sp, 'n_particles'):
                result['particles'] = sp.n_particles
            
            # Get k-effective by batch for convergence analysis
            if hasattr(sp, 'k_generation') and sp.k_generation is not None:
                k_gen = sp.k_generation
                k_eff_by_batch = []
                for i, k in enumerate(k_gen):
                    # Handle both uncertainties objects and plain floats
                    if hasattr(k, 'nominal_value'):
                        k_eff_by_batch.append({
                            'batch': i + 1, 
                            'value': float(k.nominal_value), 
                            'stdDev': float(k.std_dev) if hasattr(k, 'std_dev') else 0.0
                        })
                    else:
                        k_eff_by_batch.append({
                            'batch': i + 1, 
                            'value': float(k), 
                            'stdDev': 0.0
                        })
                result['kEffectiveByBatch'] = k_eff_by_batch
        
        # Extract tally data
        tallies = []
        for tally_id in sp.tallies:
            tally = sp.tallies[tally_id]
            tally_data = {
                'id': int(tally_id),
                'name': tally.name if hasattr(tally, 'name') else None,
                'scores': [str(s) for s in tally.scores] if hasattr(tally, 'scores') else [],
                'nuclides': [str(n) for n in tally.nuclides] if hasattr(tally, 'nuclides') else ['total'],
            }
            
            # Get tally results
            try:
                mean = tally.mean
                std_dev = tally.std_dev
                
                # Flatten multi-dimensional arrays for comparison
                mean_flat = mean.flatten() if hasattr(mean, 'flatten') else [float(mean)]
                std_flat = std_dev.flatten() if hasattr(std_dev, 'flatten') else [float(std_dev)]
                
                tally_data['mean'] = [float(m) for m in mean_flat[:10]]  # Limit to first 10 values
                tally_data['stdDev'] = [float(s) for s in std_flat[:10]]
                tally_data['totalBins'] = int(mean.size) if hasattr(mean, 'size') else 1
                
                # Get filter information
                if hasattr(tally, 'filters') and tally.filters:
                    filters = []
                    for f in tally.filters:
                        filter_info = {
                            'type': type(f).__name__,
                            'bins': len(f.bins) if hasattr(f, 'bins') else 0
                        }
                        filters.append(filter_info)
                    tally_data['filters'] = filters
                
            except Exception as e:
                tally_data['error'] = str(e)
            
            tallies.append(tally_data)
        
        result['tallies'] = tallies
        
        # Extract metadata
        try:
            result['runMode'] = str(sp.run_mode) if hasattr(sp, 'run_mode') else 'unknown'
        except:
            result['runMode'] = 'unknown'
            
        try:
            result['version'] = str(sp.version) if hasattr(sp, 'version') else 'unknown'
        except:
            result['version'] = 'unknown'
            
        try:
            result['date'] = str(sp.date_and_time) if hasattr(sp, 'date_and_time') else None
        except:
            result['date'] = None
        
        # Get entropy if available
        try:
            if hasattr(sp, 'entropy') and sp.entropy is not None:
                result['entropy'] = [float(e) for e in sp.entropy]
        except:
            pass
        
        # Get source information
        try:
            if hasattr(sp, 'source') and sp.source is not None:
                result['sourceParticles'] = len(sp.source)
        except:
            pass
        
        sp.close()
        
        return result
        
    except OSError as e:
        import traceback
        error_msg = str(e)
        if 'bad object header version number' in error_msg:
            return {
                'success': False,
                'error': 'HDF5 file appears to be corrupted or was written with a different HDF5 version. The simulation may have been interrupted.',
                'traceback': traceback.format_exc()
            }
        elif 'Unable to open' in error_msg or 'does not exist' in error_msg:
            return {
                'success': False,
                'error': f'Cannot open HDF5 file: {error_msg}',
                'traceback': traceback.format_exc()
            }
        else:
            return {
                'success': False,
                'error': f'HDF5 error: {error_msg}',
                'traceback': traceback.format_exc()
            }
    except Exception as e:
        import traceback
        return {
            'success': False,
            'error': f'Failed to read statepoint: {str(e)}',
            'traceback': traceback.format_exc()
        }


def compare_statepoints(filepaths: List[str]) -> Dict[str, Any]:
    """
    Compare multiple statepoint files and return comparison data.
    
    Args:
        filepaths: List of paths to statepoint HDF5 files
        
    Returns:
        Dictionary containing comparison results
    """
    results = []
    errors = []
    
    for filepath in filepaths:
        result = read_statepoint(filepath)
        if result.get('success'):
            results.append(result)
        else:
            errors.append({
                'file': filepath,
                'error': result.get('error', 'Unknown error')
            })
    
    # Calculate comparison statistics
    comparison = {
        'success': len(results) > 0,
        'statepoints': results,
        'errors': errors,
        'comparison': {}
    }
    
    if len(results) > 1:
        # Compare k-effective values
        keff_values = [r['kEff']['value'] for r in results if 'kEff' in r]
        if keff_values:
            comparison['comparison']['kEff'] = {
                'values': keff_values,
                'mean': sum(keff_values) / len(keff_values),
                'min': min(keff_values),
                'max': max(keff_values),
                'range': max(keff_values) - min(keff_values)
            }
        
        # Compare tally results (if same tally IDs exist)
        tally_ids = set()
        for r in results:
            if 'tallies' in r:
                tally_ids.update(t['id'] for t in r['tallies'])
        
        tally_comparisons = {}
        for tally_id in tally_ids:
            tally_data = []
            for r in results:
                if 'tallies' in r:
                    matching = [t for t in r['tallies'] if t['id'] == tally_id]
                    if matching:
                        tally_data.append({
                            'file': r['fileName'],
                            'tally': matching[0]
                        })
            
            if tally_data:
                tally_comparisons[f'tally_{tally_id}'] = tally_data
        
        comparison['comparison']['tallies'] = tally_comparisons
    
    return comparison


def read_depletion_results(filepath: str) -> Dict[str, Any]:
    """
    Read OpenMC depletion results file and extract nuclide evolution data.
    
    Args:
        filepath: Path to the depletion_results.h5 file
        
    Returns:
        Dictionary containing burnup data, nuclide concentrations, and timing
    """
    try:
        import openmc
        import h5py
        from openmc.deplete import Results
    except ImportError as e:
        return {
            'success': False,
            'error': f'Missing dependency: {e}. Please install openmc.'
        }
    
    filepath = Path(filepath)
    
    if not filepath.exists():
        return {
            'success': False,
            'error': f'File not found: {filepath}'
        }
    
    try:
        # Try to read with OpenMC's Results (from openmc.deplete)
        # Note: ResultsList was renamed to Results in OpenMC 0.13.1
        results = Results.from_hdf5(str(filepath))
        
        result = {
            'success': True,
            'filePath': str(filepath.absolute()),
            'fileName': filepath.name,
            'fileSizeMB': round(filepath.stat().st_size / (1024 * 1024), 2),
        }
        
        # Get time steps (burnup or time)
        # Use the Results.get_times() method (OpenMC 0.13.1+)
        time_steps = results.get_times(time_units='s')
        if hasattr(time_steps, 'tolist'):
            time_steps = time_steps.tolist()
        if time_steps is not None and len(time_steps) > 0:
            result['timeSteps'] = [float(t) for t in time_steps]
        
        # Try to get burnup steps from HDF5 directly
        # Note: Results.get_times() returns time, burnup is separate if present
        try:
            with h5py.File(str(filepath), 'r') as f:
                if 'burnup' in f:
                    b_steps = f['burnup'][:].tolist()
                    # Often the burnup dataset doesn't include the initial 0.0 step
                    if len(b_steps) == len(results) - 1:
                        b_steps = [0.0] + b_steps
                    
                    if b_steps:
                        result['burnupSteps'] = [float(b) for b in b_steps]
                        result['finalBurnup'] = float(b_steps[-1])
        except:
            pass
        
        # Get k-effective values using Results.get_keff() (OpenMC 0.13.1+)
        try:
            times_keff, keff_data = results.get_keff(time_units='s')
            keff_values = []
            for i, k_row in enumerate(keff_data):
                # k_row is [nominal_value, uncertainty]
                if hasattr(k_row, '__len__'):
                    keff_values.append({
                        'value': float(k_row[0]),
                        'stdDev': float(k_row[1]) if len(k_row) > 1 else 0.0
                    })
                else:
                    keff_values.append({
                        'value': float(k_row),
                        'stdDev': 0.0
                    })
            
            if keff_values:
                result['keff'] = keff_values
        except (AttributeError, Exception):
            # Fallback: try to get k from individual results
            keff_values = []
            for r in results:
                try:
                    k = r.k
                    if hasattr(k, '__len__'):
                        keff_values.append({
                            'value': float(k[0]),
                            'stdDev': float(k[1]) if len(k) > 1 else 0.0
                        })
                    else:
                        keff_values.append({
                            'value': float(k),
                            'stdDev': 0.0
                        })
                except:
                    keff_values.append({'value': 0.0, 'stdDev': 0.0})
            
            if any(k['value'] > 0 for k in keff_values):
                result['keff'] = keff_values

        # Get nuclide evolution for each material
        nuclide_data = {}
        
        # Get list of materials from first result using new API
        try:
            first_result = results[0]
            
            # Get material IDs and names from the mat_to_name mapping
            # mat_to_name maps ID (str) -> name (str), e.g., {'1': 'fuel'}
            mat_entries = []
            if hasattr(first_result, 'mat_to_name') and first_result.mat_to_name:
                for mat_id_str, mat_name in first_result.mat_to_name.items():
                    mat_entries.append((mat_id_str, mat_name))
            
            for mat_id_str, mat_name in mat_entries:
                try:
                    # Get material from first result - get_material expects the ID
                    mat_first = first_result.get_material(mat_id_str)
                    if mat_first is None:
                        continue
                    
                    mat_id = mat_first.id if hasattr(mat_first, 'id') else mat_id_str
                    mat_display_name = mat_name if mat_name else (mat_first.name if hasattr(mat_first, 'name') and mat_first.name else mat_id_str)
                    
                    # Get list of nuclides
                    nuclide_list = mat_first.get_nuclides() if hasattr(mat_first, 'get_nuclides') else []
                    
                    nuclides = {}
                    for nuc in nuclide_list:
                        try:
                            # Try to use Results.get_atoms() method (OpenMC 0.12+)
                            # This is the recommended API according to the documentation
                            times_nuc, concentrations = results.get_atoms(
                                mat=mat_id_str,
                                nuc=nuc,
                                nuc_units='atoms',
                                time_units='s'
                            )
                            if hasattr(concentrations, 'tolist'):
                                concentrations = concentrations.tolist()
                        except (AttributeError, Exception):
                            # Fallback: extract from individual results
                            concentrations = []
                            for r in results:
                                try:
                                    mat_at_time = r.get_material(mat_id_str)
                                    if mat_at_time and nuc in mat_at_time.get_nuclides():
                                        # Get nuclide densities - returns NuclideTuple with percent
                                        densities = mat_at_time.get_nuclide_densities()
                                        if nuc in densities:
                                            # Handle both tuple and direct value
                                            density_val = densities[nuc]
                                            if hasattr(density_val, 'percent'):
                                                concentrations.append(float(density_val.percent))
                                            else:
                                                concentrations.append(float(density_val))
                                        else:
                                            concentrations.append(0.0)
                                    else:
                                        concentrations.append(0.0)
                                except Exception:
                                    concentrations.append(0.0)
                        
                        if any(c > 0 for c in concentrations):
                            nuclides[nuc] = {
                                'initial': concentrations[0] if concentrations else 0.0,
                                'final': concentrations[-1] if concentrations else 0.0,
                                'min': min(concentrations) if concentrations else 0.0,
                                'max': max(concentrations) if concentrations else 0.0,
                                'concentrations': concentrations
                            }
                    
                    if nuclides:
                        nuclide_data[str(mat_id)] = {
                            'name': mat_display_name,
                            'nuclides': nuclides
                        }
                except Exception:
                    # Continue with next material
                    continue
                    
        except Exception as e:
            result['nuclideError'] = str(e)
        
        result['materials'] = nuclide_data
        result['numberOfMaterials'] = len(nuclide_data)
        
        return result
        
    except OSError as e:
        import traceback
        return {
            'success': False,
            'error': f'HDF5 error: {str(e)}',
            'traceback': traceback.format_exc()
        }
    except Exception as e:
        import traceback
        return {
            'success': False,
            'error': f'Failed to read depletion results: {str(e)}',
            'traceback': traceback.format_exc()
        }


def perform_statistical_tests(statepoints: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Perform statistical tests on statepoint comparison data.
    
    Args:
        statepoints: List of statepoint data dictionaries
        
    Returns:
        Dictionary containing statistical test results
    """
    stats = {
        'kEffective': {},
        'tallies': {}
    }
    
    # Chi-square test for k-effective consistency
    keff_data = [(sp['kEff']['value'], sp['kEff']['stdDev']) 
                 for sp in statepoints if 'kEff' in sp]
    
    if len(keff_data) >= 2:
        values = [v for v, _ in keff_data]
        uncertainties = [u for _, u in keff_data]
        
        # Weighted mean
        weights = [1.0 / (u ** 2) if u > 0 else 0.0 for u in uncertainties]
        total_weight = sum(weights)
        
        if total_weight > 0:
            weighted_mean = sum(v * w for v, w in zip(values, weights)) / total_weight
            weighted_uncertainty = sqrt(1.0 / total_weight)
            
            # Chi-square statistic
            chi2 = sum(((v - weighted_mean) / u) ** 2 for v, u in keff_data if u > 0)
            ndof = len(keff_data) - 1  # degrees of freedom
            
            stats['kEffective'] = {
                'weightedMean': weighted_mean,
                'weightedUncertainty': weighted_uncertainty,
                'chi2': chi2,
                'ndof': ndof,
                'reducedChi2': chi2 / ndof if ndof > 0 else None,
                'consistency': 'consistent' if chi2 / ndof < 3.0 else 'inconsistent' if ndof > 0 else 'unknown'
            }
            
            # Confidence interval overlap analysis
            intervals = []
            for v, u in keff_data:
                intervals.append({
                    'lower': v - 1.96 * u,  # 95% CI
                    'upper': v + 1.96 * u,
                    'value': v
                })
            
            # Find overlapping region
            max_lower = max(i['lower'] for i in intervals)
            min_upper = min(i['upper'] for i in intervals)
            
            stats['kEffective']['confidenceIntervals'] = {
                'intervals': intervals,
                'overlapExists': max_lower < min_upper,
                'overlapLower': max_lower if max_lower < min_upper else None,
                'overlapUpper': min_upper if max_lower < min_upper else None
            }
    
    # Tally consistency tests
    tally_ids = set()
    for sp in statepoints:
        if 'tallies' in sp:
            tally_ids.update(t['id'] for t in sp['tallies'])
    
    for tally_id in tally_ids:
        tally_values = []
        for sp in statepoints:
            if 'tallies' in sp:
                matching = [t for t in sp['tallies'] if t['id'] == tally_id]
                if matching and 'mean' in matching[0] and matching[0]['mean']:
                    tally_values.append({
                        'file': sp['fileName'],
                        'mean': matching[0]['mean'][0],
                        'stdDev': matching[0]['stdDev'][0] if matching[0]['stdDev'] else 0.0
                    })
        
        if len(tally_values) >= 2:
            means = [v['mean'] for v in tally_values]
            std_devs = [v['stdDev'] for v in tally_values]
            
            # Simple consistency check
            mean_of_means = sum(means) / len(means)
            max_deviation = max(abs(m - mean_of_means) for m in means)
            
            # Relative standard deviation
            rel_std = (max_deviation / mean_of_means * 100) if mean_of_means != 0 else 0.0
            
            stats['tallies'][f'tally_{tally_id}'] = {
                'values': tally_values,
                'mean': mean_of_means,
                'maxDeviation': max_deviation,
                'relativeStdDev': rel_std,
                'consistent': rel_std < 5.0  # Less than 5% variation considered consistent
            }
    
    return stats


def analyze_keff_convergence(statepoint: Dict[str, Any]) -> Dict[str, Any]:
    """
    Analyze k-effective convergence from batch data.
    
    Args:
        statepoint: Statepoint data with kEffectiveByBatch
        
    Returns:
        Convergence analysis results
    """
    if 'kEffectiveByBatch' not in statepoint or not statepoint['kEffectiveByBatch']:
        return {'success': False, 'error': 'No batch data available'}
    
    k_by_batch = statepoint['kEffectiveByBatch']
    values = [k['value'] for k in k_by_batch]
    
    n = len(values)
    
    # Running average
    running_avg = []
    for i in range(1, n + 1):
        running_avg.append(sum(values[:i]) / i)
    
    # Convergence metrics
    if len(running_avg) >= 10:
        last_10_avg = sum(running_avg[-10:]) / 10
        first_10_avg = sum(running_avg[:10]) / 10 if len(running_avg) >= 10 else running_avg[0]
        
        drift = abs(last_10_avg - first_10_avg)
        drift_percent = (drift / last_10_avg * 100) if last_10_avg != 0 else 0.0
        
        # Check for oscillation
        diffs = [running_avg[i] - running_avg[i-1] for i in range(1, len(running_avg))]
        sign_changes = sum(1 for i in range(1, len(diffs)) if diffs[i] * diffs[i-1] < 0)
        oscillation_ratio = sign_changes / len(diffs) if diffs else 0.0
        
        return {
            'success': True,
            'runningAverage': running_avg,
            'finalValue': values[-1],
            'finalUncertainty': k_by_batch[-1].get('stdDev', 0.0) if n > 0 else 0.0,
            'drift': drift,
            'driftPercent': drift_percent,
            'converged': drift_percent < 1.0 and oscillation_ratio < 0.3,
            'recommendation': ('Converged' if drift_percent < 1.0 and oscillation_ratio < 0.3 
                             else 'More batches recommended' if drift_percent > 5.0
                             else 'Acceptable convergence')
        }
    
    return {
        'success': True,
        'runningAverage': running_avg,
        'finalValue': values[-1] if values else 0.0,
        'note': 'Insufficient batches for convergence analysis'
    }


def main():
    parser = argparse.ArgumentParser(
        description='Read OpenMC statepoint files for comparison'
    )
    parser.add_argument(
        'files',
        nargs='*',
        help='Statepoint file(s) to read'
    )
    parser.add_argument(
        '--compare',
        action='store_true',
        help='Compare multiple statepoints'
    )
    parser.add_argument(
        '--json',
        action='store_true',
        help='Output as JSON'
    )
    parser.add_argument(
        '--tally-id',
        type=int,
        help='Extract specific tally by ID'
    )
    parser.add_argument(
        '--depletion',
        type=str,
        help='Read depletion results file'
    )
    parser.add_argument(
        '--stats',
        action='store_true',
        help='Include statistical tests in comparison'
    )
    parser.add_argument(
        '--convergence',
        type=str,
        help='Analyze k-effective convergence for a statepoint file'
    )
    
    args = parser.parse_args()
    
    # Handle depletion results
    if args.depletion:
        result = read_depletion_results(args.depletion)
    # Handle convergence analysis
    elif args.convergence:
        sp = read_statepoint(args.convergence)
        if sp.get('success'):
            result = analyze_keff_convergence(sp)
            result['statepoint'] = sp['fileName']
        else:
            result = sp
    # Handle comparison with stats
    elif args.compare and args.files and len(args.files) > 1:
        result = compare_statepoints(args.files)
        if args.stats and result.get('success') and result.get('statepoints'):
            result['statisticalTests'] = perform_statistical_tests(result['statepoints'])
    # Handle single or multiple files
    elif args.files:
        if len(args.files) == 1:
            result = read_statepoint(args.files[0])
        else:
            results = [read_statepoint(f) for f in args.files]
            result = {
                'success': any(r.get('success') for r in results),
                'statepoints': [r for r in results if r.get('success')],
                'errors': [{'file': f, 'error': r.get('error')} 
                          for f, r in zip(args.files, results) if not r.get('success')]
            }
            if args.stats and result['statepoints']:
                result['statisticalTests'] = perform_statistical_tests(result['statepoints'])
    else:
        parser.print_help()
        sys.exit(1)
    
    if args.json:
        print(json.dumps(result, indent=2, cls=NumpyEncoder))
    else:
        # Pretty print
        print(json.dumps(result, indent=2, cls=NumpyEncoder))
    
    # Return exit code based on success
    sys.exit(0 if result.get('success') else 1)


if __name__ == '__main__':
    main()
