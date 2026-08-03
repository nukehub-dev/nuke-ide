/** Natural isotopic abundances and atomic weights.
 * Generated from openmc.data.NATURAL_ABUNDANCE / atomic_weight.
 */
export interface ElementData {
    atomicWeight: number;
    isotopes: Record<string, number>;
}

export const NATURAL_ELEMENTS: Record<string, ElementData> = {
    Ag: { atomicWeight: 107.86814981759309, isotopes: { Ag107: 0.51839, Ag109: 0.48161 } },
    Al: { atomicWeight: 26.981538408, isotopes: { Al27: 1.0 } },
    Ar: { atomicWeight: 39.94779856192689, isotopes: { Ar36: 0.003336, Ar38: 0.000629, Ar40: 0.996035 } },
    As: { atomicWeight: 74.921594562, isotopes: { As75: 1.0 } },
    Au: { atomicWeight: 196.966570103, isotopes: { Au197: 1.0 } },
    B: { atomicWeight: 10.8118249681472, isotopes: { B10: 0.1982, B11: 0.8018 } },
    Ba: {
        atomicWeight: 137.3266717250654,
        isotopes: { Ba130: 0.0011, Ba132: 0.001, Ba134: 0.0242, Ba135: 0.0659, Ba136: 0.0785, Ba137: 0.1123, Ba138: 0.717 }
    },
    Be: { atomicWeight: 9.012183062, isotopes: { Be9: 1.0 } },
    Bi: { atomicWeight: 208.980398599, isotopes: { Bi209: 1.0 } },
    Br: { atomicWeight: 79.90360694422623, isotopes: { Br79: 0.50686, Br81: 0.49314 } },
    C: { atomicWeight: 12.011115164865895, isotopes: { C12: 0.988922, C13: 0.011078 } },
    Ca: {
        atomicWeight: 40.078022496282,
        isotopes: { Ca40: 0.96941, Ca42: 0.00647, Ca43: 0.00135, Ca44: 0.02086, Ca46: 4e-5, Ca48: 0.00187 }
    },
    Cd: {
        atomicWeight: 112.4138186323551,
        isotopes: {
            Cd106: 0.01245,
            Cd108: 0.00888,
            Cd110: 0.1247,
            Cd111: 0.12795,
            Cd112: 0.24109,
            Cd113: 0.12227,
            Cd114: 0.28754,
            Cd116: 0.07512
        }
    },
    Ce: { atomicWeight: 140.11569545842926, isotopes: { Ce136: 0.00186, Ce138: 0.00251, Ce140: 0.88449, Ce142: 0.11114 } },
    Cl: { atomicWeight: 35.45284372332529, isotopes: { Cl35: 0.757647, Cl37: 0.242353 } },
    Co: { atomicWeight: 58.933193523999996, isotopes: { Co59: 1.0 } },
    Cr: { atomicWeight: 51.9961302836779, isotopes: { Cr50: 0.04345, Cr52: 0.83789, Cr53: 0.09501, Cr54: 0.02365 } },
    Cs: { atomicWeight: 132.905451958, isotopes: { Cs133: 1.0 } },
    Cu: { atomicWeight: 63.5460394611345, isotopes: { Cu63: 0.6915, Cu65: 0.3085 } },
    Dy: {
        atomicWeight: 162.4994717383559,
        isotopes: { Dy156: 0.00056, Dy158: 0.00095, Dy160: 0.02329, Dy161: 0.18889, Dy162: 0.25475, Dy163: 0.24896, Dy164: 0.2826 }
    },
    Er: {
        atomicWeight: 167.25908420540074,
        isotopes: { Er162: 0.00139, Er164: 0.01601, Er166: 0.33503, Er167: 0.22869, Er168: 0.26978, Er170: 0.1491 }
    },
    Eu: { atomicWeight: 151.9643769235077, isotopes: { Eu151: 0.4781, Eu153: 0.5219 } },
    F: { atomicWeight: 18.99840316207, isotopes: { F19: 1.0 } },
    Fe: { atomicWeight: 55.84514363816803, isotopes: { Fe54: 0.05845, Fe56: 0.91754, Fe57: 0.02119, Fe58: 0.00282 } },
    Ga: { atomicWeight: 69.72306607905192, isotopes: { Ga69: 0.60108, Ga71: 0.39892 } },
    Gd: {
        atomicWeight: 157.25212951060638,
        isotopes: { Gd152: 0.002, Gd154: 0.0218, Gd155: 0.148, Gd156: 0.2047, Gd157: 0.1565, Gd158: 0.2484, Gd160: 0.2186 }
    },
    Ge: { atomicWeight: 72.62984885847631, isotopes: { Ge70: 0.2052, Ge72: 0.2745, Ge73: 0.0776, Ge74: 0.3652, Ge76: 0.0775 } },
    H: { atomicWeight: 1.0079817494384138, isotopes: { H1: 0.99984426, H2: 0.00015574 } },
    He: { atomicWeight: 4.002601280982136, isotopes: { He3: 2e-6, He4: 0.999998 } },
    Hf: {
        atomicWeight: 178.4849812243496,
        isotopes: { Hf174: 0.0016, Hf176: 0.0526, Hf177: 0.186, Hf178: 0.2728, Hf179: 0.1362, Hf180: 0.3508 }
    },
    Hg: {
        atomicWeight: 200.5925606434341,
        isotopes: { Hg196: 0.0015, Hg198: 0.1004, Hg199: 0.1694, Hg200: 0.2314, Hg201: 0.1317, Hg202: 0.2974, Hg204: 0.0682 }
    },
    Ho: { atomicWeight: 164.930329116, isotopes: { Ho165: 1.0 } },
    I: { atomicWeight: 126.904472592, isotopes: { I127: 1.0 } },
    In: { atomicWeight: 114.81826654967799, isotopes: { In113: 0.04281, In115: 0.95719 } },
    Ir: { atomicWeight: 192.216053805846, isotopes: { Ir191: 0.373, Ir193: 0.627 } },
    K: { atomicWeight: 39.098300908491936, isotopes: { K39: 0.932581, K40: 0.000117, K41: 0.067302 } },
    Kr: {
        atomicWeight: 83.79799973927462,
        isotopes: { Kr78: 0.00355, Kr80: 0.02286, Kr82: 0.11593, Kr83: 0.115, Kr84: 0.56987, Kr86: 0.17279 }
    },
    La: { atomicWeight: 138.90547550294534, isotopes: { La138: 0.0008881, La139: 0.9991119 } },
    Li: { atomicWeight: 6.940046609560312, isotopes: { Li6: 0.07589, Li7: 0.92411 } },
    Lu: { atomicWeight: 174.96681696885503, isotopes: { Lu175: 0.97401, Lu176: 0.02599 } },
    Mg: { atomicWeight: 24.30563130675747, isotopes: { Mg24: 0.78951, Mg25: 0.1002, Mg26: 0.11029 } },
    Mn: { atomicWeight: 54.93804304, isotopes: { Mn55: 1.0 } },
    Mo: {
        atomicWeight: 95.94877707401699,
        isotopes: { Mo92: 0.14649, Mo94: 0.09187, Mo95: 0.15873, Mo96: 0.16673, Mo97: 0.09582, Mo98: 0.24292, Mo100: 0.09744 }
    },
    N: { atomicWeight: 14.006726143066794, isotopes: { N14: 0.996337, N15: 0.003663 } },
    Na: { atomicWeight: 22.98976928195, isotopes: { Na23: 1.0 } },
    Nb: { atomicWeight: 92.90637317, isotopes: { Nb93: 1.0 } },
    Nd: {
        atomicWeight: 144.24158579072713,
        isotopes: { Nd142: 0.27153, Nd143: 0.12173, Nd144: 0.23798, Nd145: 0.08293, Nd146: 0.17189, Nd148: 0.05756, Nd150: 0.05638 }
    },
    Ne: { atomicWeight: 20.1800463795682, isotopes: { Ne20: 0.9048, Ne21: 0.0027, Ne22: 0.0925 } },
    Ni: { atomicWeight: 58.69335035422757, isotopes: { Ni58: 0.680769, Ni60: 0.262231, Ni61: 0.011399, Ni62: 0.036345, Ni64: 0.009256 } },
    O: { atomicWeight: 15.999304509238561, isotopes: { O16: 0.9976206, O17: 0.000379, O18: 0.0020004 } },
    Os: {
        atomicWeight: 190.22486144914382,
        isotopes: { Os184: 0.0002, Os186: 0.0159, Os187: 0.0196, Os188: 0.1324, Os189: 0.1615, Os190: 0.2626, Os192: 0.4078 }
    },
    P: { atomicWeight: 30.97376199768, isotopes: { P31: 1.0 } },
    Pa: { atomicWeight: 231.0358825, isotopes: { Pa231: 1.0 } },
    Pb: { atomicWeight: 207.21690757275502, isotopes: { Pb204: 0.014, Pb206: 0.241, Pb207: 0.221, Pb208: 0.524 } },
    Pd: {
        atomicWeight: 106.4153278784256,
        isotopes: { Pd102: 0.0102, Pd104: 0.1114, Pd105: 0.2233, Pd106: 0.2733, Pd108: 0.2646, Pd110: 0.1172 }
    },
    Pr: { atomicWeight: 140.907659604, isotopes: { Pr141: 1.0 } },
    Pt: {
        atomicWeight: 195.0844293345695,
        isotopes: { Pt190: 0.00012, Pt192: 0.00782, Pt194: 0.32864, Pt195: 0.33775, Pt196: 0.25211, Pt198: 0.07356 }
    },
    Rb: { atomicWeight: 85.46766359372077, isotopes: { Rb85: 0.7217, Rb87: 0.2783 } },
    Re: { atomicWeight: 186.206707299522, isotopes: { Re185: 0.374, Re187: 0.626 } },
    Rh: { atomicWeight: 102.905494081, isotopes: { Rh103: 1.0 } },
    Ru: {
        atomicWeight: 101.06493683927272,
        isotopes: { Ru96: 0.0554, Ru98: 0.0187, Ru99: 0.1276, Ru100: 0.126, Ru101: 0.1706, Ru102: 0.3155, Ru104: 0.1862 }
    },
    S: { atomicWeight: 32.0638793557218, isotopes: { S32: 0.9504074, S33: 0.0074869, S34: 0.0419599, S36: 0.0001458 } },
    Sb: { atomicWeight: 121.7597841984981, isotopes: { Sb121: 0.5721, Sb123: 0.4279 } },
    Sc: { atomicWeight: 44.955907051, isotopes: { Sc45: 1.0 } },
    Se: { atomicWeight: 78.9710814886342, isotopes: { Se74: 0.0086, Se76: 0.0923, Se77: 0.076, Se78: 0.2369, Se80: 0.498, Se82: 0.0882 } },
    Si: { atomicWeight: 28.08538366621457, isotopes: { Si28: 0.9222968, Si29: 0.0468316, Si30: 0.0308716 } },
    Sm: {
        atomicWeight: 150.3646532275396,
        isotopes: { Sm144: 0.0308, Sm147: 0.15, Sm148: 0.1125, Sm149: 0.1382, Sm150: 0.0737, Sm152: 0.2674, Sm154: 0.2274 }
    },
    Sn: {
        atomicWeight: 118.71011317193089,
        isotopes: {
            Sn112: 0.0097,
            Sn114: 0.0066,
            Sn115: 0.0034,
            Sn116: 0.1454,
            Sn117: 0.0768,
            Sn118: 0.2422,
            Sn119: 0.0859,
            Sn120: 0.3258,
            Sn122: 0.0463,
            Sn124: 0.0579
        }
    },
    Sr: { atomicWeight: 87.61664427766438, isotopes: { Sr84: 0.0056, Sr86: 0.0986, Sr87: 0.07, Sr88: 0.8258 } },
    Ta: { atomicWeight: 180.94787836423424, isotopes: { Ta180_m1: 0.0001201, Ta181: 0.9998799 } },
    Tb: { atomicWeight: 158.925353707, isotopes: { Tb159: 1.0 } },
    Te: {
        atomicWeight: 127.60312690104831,
        isotopes: { Te120: 0.0009, Te122: 0.0255, Te123: 0.0089, Te124: 0.0474, Te125: 0.0707, Te126: 0.1884, Te128: 0.3174, Te130: 0.3408 }
    },
    Th: { atomicWeight: 232.0376526217322, isotopes: { Th230: 0.0002, Th232: 0.9998 } },
    Ti: { atomicWeight: 47.8667436575575, isotopes: { Ti46: 0.0825, Ti47: 0.0744, Ti48: 0.7372, Ti49: 0.0541, Ti50: 0.0518 } },
    Tl: { atomicWeight: 204.38333226812722, isotopes: { Tl203: 0.29524, Tl205: 0.70476 } },
    Tm: { atomicWeight: 168.934218956, isotopes: { Tm169: 1.0 } },
    U: { atomicWeight: 238.0289089938894, isotopes: { U234: 5.4e-5, U235: 0.007204, U238: 0.992742 } },
    V: { atomicWeight: 50.94146566154251, isotopes: { V50: 0.0025, V51: 0.9975 } },
    W: { atomicWeight: 183.8417795990884, isotopes: { W180: 0.0012, W182: 0.265, W183: 0.1431, W184: 0.3064, W186: 0.2843 } },
    Xe: {
        atomicWeight: 131.29277126870932,
        isotopes: {
            Xe124: 0.00095,
            Xe126: 0.00089,
            Xe128: 0.0191,
            Xe129: 0.26401,
            Xe130: 0.04071,
            Xe131: 0.21232,
            Xe132: 0.26909,
            Xe134: 0.10436,
            Xe136: 0.08857
        }
    },
    Y: { atomicWeight: 88.905838156, isotopes: { Y89: 1.0 } },
    Yb: {
        atomicWeight: 173.05413078322937,
        isotopes: { Yb168: 0.00123, Yb170: 0.02982, Yb171: 0.14086, Yb172: 0.21686, Yb173: 0.16103, Yb174: 0.32025, Yb176: 0.12995 }
    },
    Zn: { atomicWeight: 65.3777822949742, isotopes: { Zn64: 0.4917, Zn66: 0.2773, Zn67: 0.0404, Zn68: 0.1845, Zn70: 0.0061 } },
    Zr: { atomicWeight: 91.22364279028989, isotopes: { Zr90: 0.5145, Zr91: 0.1122, Zr92: 0.1715, Zr94: 0.1738, Zr96: 0.028 } }
};
