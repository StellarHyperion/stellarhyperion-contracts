// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";

/// @title Deflationary and short-transfer ERC20 local test fixtures
contract DeflationaryERC20 is ERC20 {
    error Frozen(address account);

    uint8 private immutable DECIMALS;
    uint16 public transferFromFeeBps;
    uint16 public transferFeeBps;
    mapping(address account => bool frozen) public blocked;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        DECIMALS = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return DECIMALS;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFees(uint16 transferFromFeeBps_, uint16 transferFeeBps_) external {
        transferFromFeeBps = transferFromFeeBps_;
        transferFeeBps = transferFeeBps_;
    }

    function setBlocked(address account, bool frozen) external {
        blocked[account] = frozen;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (blocked[from]) revert Frozen(from);
        if (blocked[to]) revert Frozen(to);
        _spendAllowance(from, msg.sender, value);
        uint256 cut = (value * transferFromFeeBps) / 10_000;
        if (cut != 0) _burn(from, cut);
        _transfer(from, to, value - cut);
        return true;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (blocked[msg.sender]) revert Frozen(msg.sender);
        if (blocked[to]) revert Frozen(to);
        uint256 cut = (value * transferFeeBps) / 10_000;
        if (cut != 0) _burn(msg.sender, cut);
        _transfer(msg.sender, to, value - cut);
        return true;
    }
}
