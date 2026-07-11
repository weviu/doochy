"""Shared core for the scanner stack.

Modules here hold code common to the scanners (scanner.py, metals-scanner.py,
xau-scanner.py) so a change lands in one place instead of being copy-pasted
across every scanner. Each scanner stays a thin driver: its own symbol universe,
data source, and any strategy-specific logic, importing the shared pieces from here.
"""
