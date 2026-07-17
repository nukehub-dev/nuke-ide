"""Tests for cad_importer._map_surface_type_to_openmc and the gmsh-missing path."""

import cad_importer


class TestMapSurfaceTypeToOpenmc:
    def test_plane_passthrough(self):
        """Planes map to 'plane' with unchanged coefficients."""
        coeffs = [0.0, 0.0, 1.0, -5.0]
        assert cad_importer._map_surface_type_to_openmc('plane', coeffs) == ('plane', coeffs)

    def test_sphere_passthrough(self):
        """Spheres map to 'sphere' with unchanged coefficients."""
        coeffs = [1.0, 2.0, 3.0, 4.0]
        assert cad_importer._map_surface_type_to_openmc('sphere', coeffs) == ('sphere', coeffs)

    def test_x_axis_cylinder(self):
        """A cylinder with axis [1,0,0] becomes an x-cylinder."""
        coeffs = [0.0, 1.0, 2.0, 1.0, 0.0, 0.0, 3.0]
        otype, ocoeffs = cad_importer._map_surface_type_to_openmc('cylinder', coeffs)
        assert otype == 'x-cylinder'
        assert ocoeffs == coeffs

    def test_negative_x_axis_cylinder(self):
        """A cylinder with axis [-1,0,0] still becomes an x-cylinder."""
        coeffs = [0.0, 1.0, 2.0, -1.0, 0.0, 0.0, 3.0]
        otype, _ = cad_importer._map_surface_type_to_openmc('cylinder', coeffs)
        assert otype == 'x-cylinder'

    def test_y_axis_cylinder(self):
        """A cylinder with axis [0,1,0] becomes a y-cylinder."""
        coeffs = [0.0, 1.0, 2.0, 0.0, 1.0, 0.0, 3.0]
        otype, _ = cad_importer._map_surface_type_to_openmc('cylinder', coeffs)
        assert otype == 'y-cylinder'

    def test_z_axis_cylinder(self):
        """A cylinder with axis [0,0,1] becomes a z-cylinder."""
        coeffs = [0.0, 1.0, 2.0, 0.0, 0.0, 1.0, 3.0]
        otype, _ = cad_importer._map_surface_type_to_openmc('cylinder', coeffs)
        assert otype == 'z-cylinder'

    def test_tilted_cylinder_stays_general(self):
        """A non-axis-aligned cylinder keeps the generic 'cylinder' type."""
        coeffs = [0.0, 0.0, 0.0, 0.5, 0.5, 0.7071, 2.0]
        otype, ocoeffs = cad_importer._map_surface_type_to_openmc('cylinder', coeffs)
        assert otype == 'cylinder'
        assert ocoeffs is coeffs

    def test_cylinder_axis_at_classification_boundary(self):
        """Axis component just above 0.9 with others below 0.1 counts as aligned."""
        aligned = [0.0, 0.0, 0.0, 0.95, 0.05, 0.0, 1.0]
        otype, _ = cad_importer._map_surface_type_to_openmc('cylinder', aligned)
        assert otype == 'x-cylinder'

        # 0.89 < 0.9 and the y component 0.1 is not < 0.1: stays general.
        tilted = [0.0, 0.0, 0.0, 0.89, 0.1, 0.0, 1.0]
        otype, _ = cad_importer._map_surface_type_to_openmc('cylinder', tilted)
        assert otype == 'cylinder'

    def test_cones_passthrough(self):
        """Axis-aligned cone types pass through unchanged."""
        for cone in ('x-cone', 'y-cone', 'z-cone'):
            coeffs = [0.0, 0.0, 0.0, 0.25]
            assert cad_importer._map_surface_type_to_openmc(cone, coeffs) == (cone, coeffs)

    def test_toruses_passthrough(self):
        """Axis-aligned torus types pass through unchanged."""
        for torus in ('x-torus', 'y-torus', 'z-torus'):
            coeffs = [0.0, 0.0, 0.0, 5.0, 1.0, 0.0]
            assert cad_importer._map_surface_type_to_openmc(torus, coeffs) == (torus, coeffs)

    def test_quadric_passthrough(self):
        """Quadrics map to 'quadric' with unchanged coefficients."""
        coeffs = [1.0] * 10
        assert cad_importer._map_surface_type_to_openmc('quadric', coeffs) == ('quadric', coeffs)

    def test_unknown_type_falls_back_to_plane(self):
        """Unknown surface types fall back to 'plane'."""
        coeffs = [1.0, 0.0, 0.0, 0.0]
        assert cad_importer._map_surface_type_to_openmc('nurbs', coeffs) == ('plane', coeffs)


def test_convert_cad_to_openmc_without_gmsh(monkeypatch):
    """Without gmsh, conversion fails fast with a clear error dict."""
    monkeypatch.setattr(cad_importer.gmsh_utils, 'HAS_GMSH', False)
    result = cad_importer.convert_cad_to_openmc('/nonexistent/model.step')
    assert result == {'success': False, 'error': 'gmsh not available'}
