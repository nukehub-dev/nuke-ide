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
