import unittest

from app.billing.tax import compute_tax


class TaxTest(unittest.TestCase):
    def test_standard_rate(self):
        self.assertEqual(compute_tax(100), 20.0)
