"""
Material and nuclide commands.
"""

import json
import sys
import os


# Group structure cache
_group_structures_cache = None


def load_group_structures():
    """Load group structure definitions from multiple sources."""
    global _group_structures_cache
    
    if _group_structures_cache is not None:
        return _group_structures_cache
    
    structures = {}
    metadata = {"openmc_available": False, "sources": []}
    
    # 1. Try to load built-in OpenMC structures
    try:
        import openmc.mgxs
        for name, edges in openmc.mgxs.GROUP_STRUCTURES.items():
            structures[name] = sorted(edges, reverse=True)
        metadata["openmc_available"] = True
        metadata["sources"].append("OpenMC Built-ins")
    except ImportError:
        pass
    
    # 2. Load from YAML files
    yaml_locations = [
        (os.path.expanduser('~/.nuke-ide/group_structures.yaml'), "Global IDE Config"),
        (os.path.join(os.getcwd(), 'group_structures.yaml'), "Project Config")
    ]
    
    for yaml_path, source_name in yaml_locations:
        if os.path.exists(yaml_path):
            try:
                import yaml
                with open(yaml_path, 'r') as f:
                    data = yaml.safe_load(f)
                if data and 'structures' in data:
                    for name, info in data['structures'].items():
                        if 'boundaries_eV' in info:
                            structures[name] = sorted(info['boundaries_eV'], reverse=True)
                    metadata["sources"].append(source_name)
            except ImportError:
                print(f"[XS Plot] PyYAML not installed, skipping {yaml_path}", file=sys.stderr)
            except Exception as e:
                print(f"[XS Plot] Error loading {yaml_path}: {e}", file=sys.stderr)
    
    _group_structures_cache = (structures, metadata)
    return _group_structures_cache


def cmd_list_group_structures(args):
    """List available group structures."""
    structures_dict, metadata = load_group_structures()
    
    # Convert dictionary to array of objects for frontend compatibility
    structures_array = []
    for name, boundaries in structures_dict.items():
        structures_array.append({
            "name": name,
            "groups": len(boundaries) - 1 if len(boundaries) > 1 else 0,
            "boundaries": boundaries
        })
    
    print(json.dumps({
        "structures": structures_array,
        "metadata": metadata
    }, indent=2))
    return 0


def cmd_list_thermal_materials(args):
    """List thermal scattering materials."""
    try:
        import openmc.data
        
        # Get the cross sections path from environment or argument
        cross_sections = args.cross_sections if args.cross_sections else None
        
        if cross_sections:
            data = openmc.data.DataLibrary.from_xml(cross_sections)
        else:
            data = openmc.data.DataLibrary.open()
        
        # Extract thermal materials
        thermal_materials = []
        for entry in data.libraries:
            if isinstance(entry, dict):
                if entry.get('type') == 'thermal':
                    materials = entry.get('materials', [])
                    thermal_materials.extend(materials)
        
        thermal_materials = sorted(set(thermal_materials))
        print(json.dumps({"thermal_materials": thermal_materials}))
        return 0
        
    except Exception as e:
        import traceback
        print(json.dumps({"thermal_materials": [], "error": str(e)}))
        return 1


def cmd_list_nuclides(args):
    """List available nuclides from cross_sections.xml."""
    try:
        import openmc
        import openmc.data
    except ImportError as e:
        print(json.dumps({"nuclides": [], "error": f"OpenMC not installed: {e}"}))
        return 1

    try:
        # Get the cross sections path from environment or argument
        cross_sections = args.cross_sections if args.cross_sections else None
        
        if cross_sections:
            # Load specific cross_sections.xml
            data = openmc.data.DataLibrary.from_xml(cross_sections)
        else:
            # Try to use default cross sections
            try:
                data = openmc.data.DataLibrary.open()
            except:
                # If that fails, return common nuclides
                common_nuclides = [
                    'H1', 'H2', 'He3', 'He4', 'Li6', 'Li7', 'Be9', 'B10', 'B11',
                    'C0', 'N14', 'N15', 'O16', 'O17', 'O18', 'F19', 'Na23', 'Mg24',
                    'Al27', 'Si28', 'P31', 'S32', 'Cl35', 'K39', 'Ca40', 'Sc45',
                    'Ti46', 'V51', 'Cr52', 'Mn55', 'Fe54', 'Co59', 'Ni58', 'Cu63',
                    'Ga69', 'Ge70', 'As75', 'Se76', 'Br79', 'Kr80', 'Rb85', 'Sr86',
                    'Y89', 'Zr90', 'Nb93', 'Mo96', 'Tc99', 'Ru100', 'Rh103', 'Pd104',
                    'Ag107', 'Cd110', 'In113', 'Sn114', 'Sb121', 'Te122', 'I127',
                    'Xe128', 'Cs133', 'Ba134', 'La139', 'Ce140', 'Pr141', 'Nd142',
                    'Pm147', 'Sm144', 'Eu151', 'Gd156', 'Tb159', 'Dy162', 'Ho165',
                    'Er166', 'Tm169', 'Yb168', 'Lu175', 'Hf174', 'Ta181', 'W182',
                    'Re185', 'Os190', 'Ir191', 'Pt192', 'Au197', 'Hg200', 'Tl203',
                    'Pb204', 'Bi209', 'Th232', 'Pa231', 'U234', 'U235', 'U238',
                    'Np237', 'Pu238', 'Pu239', 'Pu240', 'Pu241', 'Pu242', 'Am241',
                    'Am242', 'Am243', 'Cm244', 'Cm245', 'Cm246', 'Cm247', 'Cm248'
                ]
                print(json.dumps({"nuclides": common_nuclides}))
                return 0
        
        # Extract nuclide names from the data library
        nuclides = []
        
        # In newer OpenMC versions, data.libraries is a DataLibrary object containing dicts
        for entry in data.libraries:
            # Entry is a dict with 'path', 'type', 'materials' keys
            if isinstance(entry, dict):
                materials = entry.get('materials', [])
                if materials:
                    nuclides.extend(materials)
            else:
                # Handle old API where entry might be an object with tables
                tables = getattr(entry, 'tables', [])
                if isinstance(tables, dict):
                    tables = tables.values()
                for table in tables:
                    if hasattr(table, 'nuclide'):
                        nuclides.append(table.nuclide)
                    elif hasattr(table, 'name'):
                        nuclides.append(table.name)
        
        # Remove duplicates and sort
        nuclides = sorted(set(nuclides))
        
        print(json.dumps({"nuclides": nuclides}))
        return 0
        
    except Exception as e:
        import traceback
        print(json.dumps({"nuclides": [], "error": str(e), "traceback": traceback.format_exc()}))
        return 1


def cmd_materials(args):
    """Parse and return materials from materials.xml file."""
    try:
        from openmc_materials_parser import parse_materials_file
        result = parse_materials_file(args.file)
        print(json.dumps(result))
        return 0 if 'error' not in result else 1
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


def cmd_material_cell_linkage(args):
    """Get mapping of materials to cells that use them."""
    try:
        from openmc_materials_parser import get_material_cell_linkage
        result = get_material_cell_linkage(args.materials_file, args.geometry_file)
        print(json.dumps(result))
        return 0 if 'error' not in result else 1
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


def cmd_add_material(args):
    """Add a material XML snippet to an existing materials.xml file."""
    try:
        import xml.etree.ElementTree as ET
        
        if not os.path.exists(args.file):
            # Create new materials.xml
            root = ET.Element('materials')
        else:
            tree = ET.parse(args.file)
            root = tree.getroot()
            
        # Parse the new material snippet
        new_mat_elem = ET.fromstring(args.material_xml)
        
        # Check if ID already exists
        new_id = new_mat_elem.get('id')
        for existing in root.findall('material'):
            if existing.get('id') == new_id:
                root.remove(existing)
                
        root.append(new_mat_elem)
        
        # Write back
        # indent for readability
        def indent(elem, level=0):
            i = "\n" + level*"  "
            if len(elem):
                if not elem.text or not elem.text.strip():
                    elem.text = i + "  "
                if not elem.tail or not elem.tail.strip():
                    elem.tail = i
                for elem in elem:
                    indent(elem, level+1)
                if not elem.tail or not elem.tail.strip():
                    elem.tail = i
            else:
                if level and (not elem.tail or not elem.tail.strip()):
                    elem.tail = i
        
        indent(root)
        tree = ET.ElementTree(root)
        tree.write(args.file, encoding='utf-8', xml_declaration=True)
        
        print(json.dumps({"success": True}))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1


def cmd_mix_materials(args):
    """
    Mix multiple materials into a new material using Manual Homogenization.
    
    This bypasses OpenMC's mix_materials limitations (especially S(a,b) restrictions)
    by manually calculating nuclide concentrations and densities.
    """
    try:
        import openmc
        import xml.etree.ElementTree as ET
        from collections import defaultdict
        
        if not os.path.exists(args.file):
            print(json.dumps({"error": f"Materials file not found: {args.file}"}))
            return 1
            
        materials_obj = openmc.Materials.from_xml(args.file)
        
        try:
            mat_ids = [int(i) for i in args.material_ids.split(',')]
            fractions = [float(f) for f in args.fractions.split(',')]
        except ValueError as e:
            print(json.dumps({"error": f"Invalid material IDs or fractions: {e}"}))
            return 1
            
        mats_to_mix = []
        for mid in mat_ids:
            found_mat = next((m for m in materials_obj if m.id == mid), None)
            if not found_mat:
                print(json.dumps({"error": f"Material {mid} not found"}))
                return 1
            mats_to_mix.append(found_mat)

        # Check for S(a,b) and collect for warning
        sab_warnings = []
        for m in mats_to_mix:
            if hasattr(m, '_sab') and m._sab:
                for sab in m._sab:
                    sab_warnings.append(f"Material '{m.name}' (ID {m.id}) contains {sab}")

        # =========================================================================
        # MANUAL HOMOGENIZATION - Bypass OpenMC mix_materials limitations
        # =========================================================================
        
        percent_type = args.percent_type
        
        if percent_type == 'vo':
            # VOLUME HOMOGENIZATION
            # For volume mixing: N_total = sum(v_i * rho_i * N_av / M_i) for atoms
            # We calculate the weighted average density and atomic densities
            
            total_volume_frac = sum(fractions)
            if total_volume_frac == 0:
                print(json.dumps({"error": "Volume fractions sum to zero"}))
                return 1
            
            # Calculate effective density
            effective_density = sum(
                v * m.density for v, m in zip(fractions, mats_to_mix)
            )
            
            # Collect all nuclides with their volume-weighted number densities
            # N_nuclide = sum(v_i * n_i) where n_i is number density in material i
            nuclide_number_densities = defaultdict(float)
            
            for mat, vol_frac in zip(mats_to_mix, fractions):
                # Get number density for each nuclide in this material
                # For atom fraction: n = rho * fraction / (atomic_mass * N_A) * N_A
                # = rho * fraction / atomic_mass (in mol/cm^3 * N_A = atoms/cm^3 / barns?)
                # OpenMC stores densities in atom/b-cm for 'ao' or g/cm^3 for 'wo'
                
                mat_density = mat.density
                
                for nuc_name, frac, frac_type in mat.nuclides:
                    if frac_type == 'ao':
                        # Atom fraction - directly proportional to number density
                        # n = rho * fraction (when rho is in atom/b-cm)
                        if mat.density_units == 'atom/b-cm':
                            number_density = mat_density * frac  # atoms/b-cm
                        else:
                            # Convert from g/cm^3 using atomic mass
                            # This shouldn't happen for 'ao' type, but handle it
                            number_density = mat_density * frac
                    elif frac_type == 'wo':
                        # Weight fraction - need to convert to atom fraction first
                        # Get atomic mass from openmc
                        try:
                            nuc = openmc.Nuclide(nuc_name)
                            atomic_mass = nuc.atomic_mass  # g/mol
                            # n = rho * (wo / A) / sum(wo_j / A_j) for all j
                            # Simplified: effective atoms = rho * wo / A
                            number_density = mat_density * frac / atomic_mass
                        except:
                            # Fallback: assume atomic mass ~ A number
                            mass_number = int(''.join(filter(str.isdigit, nuc_name)) or 1)
                            number_density = mat_density * frac / mass_number
                    else:
                        # Default: treat as atom fraction
                        number_density = mat_density * frac
                    
                    # Weight by volume fraction
                    nuclide_number_densities[nuc_name] += vol_frac * number_density
            
            # Normalize to get atom fractions
            total_number_density = sum(nuclide_number_densities.values())
            if total_number_density > 0:
                nuclide_atom_fractions = {
                    nuc: n / total_number_density 
                    for nuc, n in nuclide_number_densities.items()
                }
            else:
                nuclide_atom_fractions = {nuc: 0 for nuc in nuclide_number_densities}
            
            # Calculate effective number density (atom/b-cm)
            effective_number_density = total_number_density / total_volume_frac if total_volume_frac > 0 else 0
            
        elif percent_type == 'wo':
            # WEIGHT HOMOGENIZATION
            # Mix by mass fractions
            
            total_mass_frac = sum(fractions)
            if total_mass_frac == 0:
                print(json.dumps({"error": "Weight fractions sum to zero"}))
                return 1
            
            # Calculate effective density
            effective_density = sum(
                f * m.density for f, m in zip(fractions, mats_to_mix)
            ) / total_mass_frac
            
            # Collect nuclide mass fractions
            nuclide_mass_fractions = defaultdict(float)
            
            for mat, mass_frac in zip(mats_to_mix, fractions):
                for nuc_name, frac, frac_type in mat.nuclides:
                    if frac_type == 'wo':
                        # Direct mass contribution
                        nuclide_mass_fractions[nuc_name] += mass_frac * frac
                    elif frac_type == 'ao':
                        # Convert atom fraction to mass fraction
                        try:
                            nuc = openmc.Nuclide(nuc_name)
                            atomic_mass = nuc.atomic_mass
                            # wo = ao * A / sum(ao_j * A_j)
                            # Approximate: weight contribution proportional to ao * A
                            mass_contrib = frac * atomic_mass
                            nuclide_mass_fractions[nuc_name] += mass_frac * mass_contrib
                        except:
                            mass_number = int(''.join(filter(str.isdigit, nuc_name)) or 1)
                            mass_contrib = frac * mass_number
                            nuclide_mass_fractions[nuc_name] += mass_frac * mass_contrib
            
            # Normalize mass fractions
            total_mass = sum(nuclide_mass_fractions.values())
            if total_mass > 0:
                nuclide_mass_fractions = {
                    nuc: m / total_mass for nuc, m in nuclide_mass_fractions.items()
                }
            
            # Store as atom fractions (will be set with set_density('atom/b-cm', ...) and add_nuclide with ao)
            # Convert wo to ao for material creation
            nuclide_atom_fractions = {}
            total_ao_weight = 0
            ao_weights = {}
            
            for nuc_name, wo in nuclide_mass_fractions.items():
                try:
                    nuc = openmc.Nuclide(nuc_name)
                    atomic_mass = nuc.atomic_mass
                    ao_weight = wo / atomic_mass
                except:
                    mass_number = int(''.join(filter(str.isdigit, nuc_name)) or 1)
                    ao_weight = wo / mass_number
                ao_weights[nuc_name] = ao_weight
                total_ao_weight += ao_weight
            
            for nuc_name, ao_weight in ao_weights.items():
                nuclide_atom_fractions[nuc_name] = ao_weight / total_ao_weight if total_ao_weight > 0 else 0
            
            # For weight mixing, we need to convert to atom density for storage
            # But we'll return weight fractions in the result
            effective_number_density = 0  # Will be calculated from density
            
        else:
            # ATOM HOMOGENIZATION (ao)
            total_atom_frac = sum(fractions)
            if total_atom_frac == 0:
                print(json.dumps({"error": "Atom fractions sum to zero"}))
                return 1
            
            # Calculate weighted density
            effective_density = sum(
                f * m.density for f, m in zip(fractions, mats_to_mix)
            ) / total_atom_frac
            
            # Collect nuclide atom fractions
            nuclide_atom_fractions = defaultdict(float)
            
            for mat, atom_frac in zip(mats_to_mix, fractions):
                for nuc_name, frac, frac_type in mat.nuclides:
                    if frac_type == 'ao':
                        nuclide_atom_fractions[nuc_name] += atom_frac * frac
                    elif frac_type == 'wo':
                        # Convert wo to ao
                        try:
                            nuc = openmc.Nuclide(nuc_name)
                            atomic_mass = nuc.atomic_mass
                            ao = frac / atomic_mass
                            nuclide_atom_fractions[nuc_name] += atom_frac * ao
                        except:
                            mass_number = int(''.join(filter(str.isdigit, nuc_name)) or 1)
                            ao = frac / mass_number
                            nuclide_atom_fractions[nuc_name] += atom_frac * ao
            
            # Normalize
            total_ao = sum(nuclide_atom_fractions.values())
            if total_ao > 0:
                nuclide_atom_fractions = {
                    nuc: a / total_ao for nuc, a in nuclide_atom_fractions.items()
                }
            
            effective_number_density = 0

        # Create the new material with manual nuclides
        mixed_mat = openmc.Material(
            material_id=args.id if args.id else None,
            name=args.name if args.name else "Mixed Material"
        )
        
        # Set density and add nuclides
        if percent_type == 'wo':
            # For weight fraction mixing, store as g/cm^3
            mixed_mat.set_density('g/cm3', effective_density)
            for nuc_name, ao_frac in nuclide_atom_fractions.items():
                # We need to convert ao back to wo for the material definition
                # Since we calculated ao from wo, we can use the original mass fractions
                if nuc_name in nuclide_mass_fractions:
                    mixed_mat.add_nuclide(nuc_name, nuclide_mass_fractions[nuc_name], percent_type='wo')
        else:
            # For atom/volume mixing, use atom/b-cm
            # Estimate number density from typical value if not calculated
            if effective_number_density <= 0:
                # Estimate based on typical solid density ~5 g/cm^3 with average A~50
                N_A = 6.022e23
                effective_number_density = effective_density * N_A / 50 * 1e-24  # rough estimate
            mixed_mat.set_density('atom/b-cm', effective_number_density if percent_type == 'vo' else effective_density)
            for nuc_name, ao_frac in nuclide_atom_fractions.items():
                mixed_mat.add_nuclide(nuc_name, ao_frac, percent_type='ao')

        # Prepare response nuclides
        nuclides = []
        if percent_type == 'wo':
            # Return weight fractions
            for nuc_name, frac in nuclide_mass_fractions.items():
                nuclides.append({
                    'name': nuc_name,
                    'fraction': frac,
                    'fractionType': 'wo'
                })
        else:
            # Return atom fractions
            for nuc_name, frac in nuclide_atom_fractions.items():
                nuclides.append({
                    'name': nuc_name,
                    'fraction': frac,
                    'fractionType': 'ao'
                })
            
        # Thermal scattering - pass info but don't add (user must handle manually)
        thermal_scattering = []
        if sab_warnings:
            thermal_scattering = [{'name': w.split('contains ')[-1]} for w in sab_warnings if 'contains ' in w]
            
        result = {
            'id': mixed_mat.id,
            'name': mixed_mat.name,
            'density': mixed_mat.density,
            'densityUnit': mixed_mat.density_units,
            'nuclides': nuclides,
            'thermalScattering': thermal_scattering,
            'isDepletable': any(m.depletable for m in mats_to_mix),
            'totalNuclides': len(nuclides),
            'xml': ET.tostring(mixed_mat.to_xml_element(), encoding='unicode'),
            'warnings': sab_warnings if sab_warnings else [],
            'method': 'Manual Homogenization',
            'fractionType': percent_type
        }
        
        print(json.dumps(result))
        return 0
        
    except Exception as e:
        import traceback
        print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}))
        return 1
