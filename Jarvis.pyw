"""Startet Jarvis ohne Konsolenfenster (für die Verknüpfungen und den Autostart).

    pythonw Jarvis.pyw                 Jarvis mit Fenster
    pythonw Jarvis.pyw --hintergrund   unsichtbar, nur das Symbol neben der Uhr
"""

import sys

from jarvis.__main__ import main

sys.exit(main())
